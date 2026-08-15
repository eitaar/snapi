import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
import { runInThisContext } from "node:vm";
import "fake-indexeddb/auto";
import { getBuildProfile } from "../builds.js";
import type { BuildId } from "../builds.js";
import { createOfficialNetworkBoundary } from "./official-network.js";
import { serializeOfficialFriendState } from "./official-friend-snapshot.js";
import {
  isOfficialAuthFailure,
  officialSessionExpiredError,
  OFFICIAL_SESSION_EXPIRED_ERROR_NAME,
} from "./official-auth-failure.js";
import {
  downloadIncomingMedia,
  MAX_INCOMING_MEDIA_LAYERS,
} from "./incoming-media-download.js";
import { installOfficialWebSocket } from "./official-websocket.js";
import {
  describeOfficialDuplexCause,
  instrumentOfficialDuplexErrors,
  registerOfficialMainAssetWithWorkerExports,
  waitForOfficialBootstrapRegistration,
} from "./official-duplex-diagnostics.js";
import { patchOfficialBootstrap } from "./official-webpack-bridge.js";

if (parentPort === null) throw new Error("Official messaging Worker host requires a parent port");
const data = workerData as {
  readonly assetDir: string;
  readonly buildId?: BuildId;
  readonly allowNetwork?: boolean;
};
const profile = getBuildProfile(data.buildId ?? "8dd50222");
const bootstrapPath = resolve(data.assetDir, profile.officialWorker.bootstrapAsset);
const dynamicChunkPath = resolve(data.assetDir, profile.officialWorker.dynamicChunkAsset);
const mainAssetPath = resolve(data.assetDir, profile.officialWorker.mainAsset);
const wasmPath = resolve(data.assetDir, profile.officialWorker.wasmAsset);
const listeners = new Map<string, Set<(event: { readonly data?: unknown }) => void>>();
let webCookieHeader: string | undefined;
let ssoCookieHeader: string | undefined;
let officialHttpToken: string | undefined;
let mediaResolverReady = false;

function listenersFor(type: string): Set<(event: { readonly data?: unknown }) => void> {
  let set = listeners.get(type);
  if (set === undefined) {
    set = new Set();
    listeners.set(type, set);
  }
  return set;
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}

const target = globalThis as unknown as Record<PropertyKey, unknown>;
Object.defineProperties(target, {
  __officialDescribeDuplexCause: {
    value: describeOfficialDuplexCause,
    configurable: true,
  },
  self: { value: globalThis, configurable: true, writable: true },
  window: { value: globalThis, configurable: true, writable: true },
  WorkerGlobalScope: { value: Object, configurable: true, writable: true },
  process: { value: undefined, configurable: true, writable: true },
  navigator: {
    value: {
      userAgent: `Mozilla/5.0 Chrome/140.0.0.0 SnapchatWeb/${profile.buildId}`,
      userAgentData: { brands: [{ brand: "Chromium", version: "140" }] },
      language: "ja-JP",
      languages: ["ja-JP", "ja", "en-US", "en"],
      onLine: true,
    },
    configurable: true,
    writable: true,
  },
  location: {
    value: {
      origin: "https://web.snapchat.com",
      href: "https://web.snapchat.com/web/",
      pathname: "/web/",
    },
    configurable: true,
    writable: true,
  },
  document: {
    value: {
      addEventListener() {},
      removeEventListener() {},
      hasFocus: () => true,
      get cookie() { return webCookieHeader ?? ""; },
      set cookie(_value: string) {},
    },
    configurable: true,
    writable: true,
  },
  localStorage: { value: createStorage(), configurable: true, writable: true },
  sessionStorage: { value: createStorage(), configurable: true, writable: true },
  MessageChannel: { value: MessageChannel, configurable: true, writable: true },
});

const NativeResponse = Response;
class AssetResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    Object.defineProperty(this, "url", {
      value: profile.officialWorker.wasmUrl,
    });
  }
}
Object.defineProperty(target, "Response", { value: AssetResponse, configurable: true, writable: true });

const nativeFetch = fetch;
const networkBoundary = createOfficialNetworkBoundary(data.allowNetwork, nativeFetch, {
  webCookieHeader: () => webCookieHeader,
  ssoCookieHeader: () => ssoCookieHeader,
  httpToken: () => officialHttpToken,
});
Object.defineProperty(target, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(profile.officialWorker.wasmAsset)) {
      return new AssetResponse(readFileSync(wasmPath), {
        status: 200,
        headers: { "content-type": "application/wasm" },
      });
    }
    return networkBoundary.fetch(input, init);
  },
  configurable: true,
  writable: true,
});

Object.defineProperties(target, {
  addEventListener: {
    value: (type: string, listener: (event: { readonly data?: unknown }) => void) => {
      listenersFor(type).add(listener);
    },
    configurable: true,
  },
  removeEventListener: {
    value: (type: string, listener: (event: { readonly data?: unknown }) => void) => {
      listenersFor(type).delete(listener);
    },
    configurable: true,
  },
  postMessage: {
    value: (value: unknown, transfer?: readonly Transferable[]) => {
      parentPort!.postMessage(value, transfer as readonly import("node:worker_threads").TransferListItem[] | undefined);
    },
    configurable: true,
  },
  importScripts: {
    value: (...urls: readonly string[]) => {
      for (const url of urls) {
        if (!url.includes(profile.officialWorker.dynamicChunkAsset)) {
          throw new Error("Official messaging Worker requested an unverified dynamic chunk");
        }
        runInThisContext(readFileSync(dynamicChunkPath, "utf8"), { filename: dynamicChunkPath });
      }
    },
    configurable: true,
  },
});

// The official bundle calls the browser WebSocket constructor with only its
// URL and subprotocols. Node does not synthesize the page Origin header, so
// install the narrow compatibility wrapper before evaluating the bundle.
const officialWebSocket = installOfficialWebSocket("https://www.snapchat.com", {
  allowNetwork: data.allowNetwork === true,
});

function officialWebpackRequire(): ((id: string | number) => unknown) {
  const require = target.__officialWebpackRequire;
  if (typeof require !== "function") throw new Error("Official Webpack runtime is unavailable");
  return require as (id: string | number) => unknown;
}

function safeTypeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof TypeError)) return undefined;
  const message = error.message;
  const read = /^Cannot read properties of (undefined|null) \(reading '([A-Za-z_$][A-Za-z0-9_$]*)'\)$/.exec(message);
  if (read !== null) return `read-${read[1]}-${read[2]}`;
  const set = /^Cannot set properties of (undefined|null) \(setting '([A-Za-z_$][A-Za-z0-9_$]*)'\)$/.exec(message);
  if (set !== null) return `set-${set[1]}-${set[2]}`;
  const notAFunction = /^([A-Za-z_$][A-Za-z0-9_$.(\[\])]+) is not a function$/.exec(message);
  if (notAFunction !== null) return `not-a-function-${notAFunction[1]}`;
  if (message.includes("is not a function")) return "not-a-function";
  return "type-error";
}

function safeErrorDetail(error: unknown): string | undefined {
  const typeDetail = safeTypeErrorDetail(error);
  if (typeDetail !== undefined) return typeDetail;
  if (!(error instanceof ReferenceError)) return undefined;
  const missing = /^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/.exec(error.message);
  if (missing !== null) return `missing-${missing[1]}`;
  const sanitized = error.message.replace(/[^A-Za-z0-9_$' .()]/g, "");
  return sanitized.length > 0 && sanitized.length <= 80 ? `reference-${sanitized}` : "reference-error";
}

async function resolveIncomingMedia(
  mediaInfo: unknown,
  context: string,
  accountId: string,
): Promise<unknown> {
  const mediaInfoRecord = mediaInfo !== null && typeof mediaInfo === "object"
    ? mediaInfo as { readonly mediaReference?: unknown }
    : {};
  const mediaReference = mediaInfoRecord.mediaReference !== null &&
      typeof mediaInfoRecord.mediaReference === "object"
    ? mediaInfoRecord.mediaReference as { readonly resolvedUrl?: unknown; readonly localCacheKey?: unknown }
    : {};
  const needsContentResolver = typeof mediaReference.resolvedUrl !== "string" &&
    typeof mediaReference.localCacheKey !== "string";
  if (!mediaResolverReady && needsContentResolver) {
    const require = officialWebpackRequire();
    const authStore = (require(profile.officialWorker.userStoreModuleId) as {
      readonly M: {
        readonly getState: () => { readonly auth?: Record<string, unknown> };
        readonly setState?: (value: unknown) => void;
      };
    }).M;
    const authState = authStore.getState();
    if (authStore.setState !== undefined && authState.auth !== undefined) {
      authStore.setState({ auth: { ...authState.auth, userId: accountId } });
    }
    const cofStore = (require("48688") as {
      readonly s: {
        readonly getState: () => { readonly clientContext?: unknown; readonly initCofStore?: () => unknown };
      };
    }).s;
    const cofState = cofStore.getState();
    if (cofState.clientContext === undefined) {
      await cofState.initCofStore?.();
    }
    const wasmModule = target.__officialWasmModule;
    if (wasmModule === undefined) throw new Error("Official WASM module is unavailable");
    const resolver = officialWebpackRequire()("98174") as {
      readonly VJ: (module: unknown) => void;
    };
    resolver.VJ(wasmModule);
    mediaResolverReady = true;
  }

  const mediaModule = officialWebpackRequire()("46592") as {
    readonly V: (info: unknown, context: string) => Promise<readonly {
      readonly dataUrl?: unknown;
      readonly mediaLayerType?: unknown;
      readonly hasAudio?: unknown;
      readonly width?: unknown;
      readonly height?: unknown;
    }[]>;
  };
  const layers = await mediaModule.V(mediaInfo, context);
  if (layers.length > MAX_INCOMING_MEDIA_LAYERS) {
    throw new Error("Official media resolver exceeded the layer limit");
  }
  const resolved = [];
  for (const layer of layers) {
    if (typeof layer.dataUrl !== "string") throw new Error("Official media resolver returned no URL");
    try {
      const downloaded = await downloadIncomingMedia(layer.dataUrl, networkBoundary.fetch);
      resolved.push({
        ...downloaded,
        ...(typeof layer.mediaLayerType === "number" ? { mediaLayerType: layer.mediaLayerType } : {}),
        hasAudio: Boolean(layer.hasAudio),
        ...(typeof layer.width === "number" ? { width: layer.width } : {}),
        ...(typeof layer.height === "number" ? { height: layer.height } : {}),
      });
    } finally {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(layer.dataUrl);
    }
  }
  return resolved;
}

function applyCurrentOfficialAuthStore(
  userStore: {
    readonly getState: () => { readonly auth?: Record<string, unknown> };
    readonly setState?: (value: unknown) => void;
  } | undefined,
  accountId: string | undefined,
): void {
  const beforeState = userStore?.getState();
  if (userStore?.setState === undefined || beforeState?.auth === undefined) return;
  const currentAuthToken = beforeState.auth.authToken !== null &&
      typeof beforeState.auth.authToken === "object"
    ? beforeState.auth.authToken as Record<string, unknown>
    : {};
  userStore.setState({
    auth: {
      ...beforeState.auth,
      ...(accountId === undefined ? {} : { userId: accountId }),
      ...(officialHttpToken === undefined ? {} : {
        authToken: {
          ...currentAuthToken,
          token: officialHttpToken,
          lastTokenRefresh: Date.now(),
        },
      }),
    },
  });
}

async function syncFriends(accountId: string | undefined): Promise<unknown> {
  let stage = "load-store";
  try {
    const require = officialWebpackRequire() as ((id: string | number) => unknown) & {
      readonly m?: Record<string, unknown>;
    };
    const moduleId = profile.officialWorker.userStoreModuleId;
    if (require.m !== undefined && !Object.prototype.hasOwnProperty.call(require.m, moduleId)) {
      throw new Error("Official user store module is not registered for this build");
    }
    const store = require(moduleId) as {
      readonly M?: {
        readonly getState: () => { readonly auth?: Record<string, unknown>; readonly user?: unknown };
        readonly setState?: (value: unknown) => void;
      };
    };
    const userStore = store.M;
    stage = "set-account-id";
    applyCurrentOfficialAuthStore(userStore, accountId);
    stage = "read-user-store";
    const before = userStore?.getState().user;
    if (before === null || typeof before !== "object" || typeof (before as { syncFriends?: unknown }).syncFriends !== "function") {
      throw new Error("Official friend store is not initialized");
    }
    stage = "sync-friends";
    networkBoundary.drainObservedRequests();
    try {
      await (before as { syncFriends: () => Promise<void> }).syncFriends();
    } catch (error) {
      const observed = networkBoundary.drainObservedRequests();
      if (isOfficialAuthFailure(error, observed)) throw officialSessionExpiredError();
      throw new Error("Official friend synchronization failed");
    }
    stage = "serialize-friends";
    const user = userStore?.getState().user;
    return serializeOfficialFriendState(user, new Date().toISOString());
  } catch (error) {
    if (error instanceof Error && (
      error.name === OFFICIAL_SESSION_EXPIRED_ERROR_NAME ||
      error.message === "Official friend synchronization failed"
    )) throw error;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const detail = safeErrorDetail(error);
    throw new Error(`Official friend synchronization failed at ${stage} (${errorName}${detail === undefined ? "" : `:${detail}`})`);
  }
}

async function handleHostControl(message: unknown): Promise<boolean> {
  if (message === null || typeof message !== "object") return false;
  const candidate = message as {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly path?: unknown;
    readonly argumentList?: readonly { readonly type?: unknown; readonly value?: unknown }[];
  };
  if (
    typeof candidate.id !== "string" ||
    candidate.type !== "APPLY" ||
    !Array.isArray(candidate.path) ||
    candidate.path[0] !== "__host"
  ) return false;
  let value: unknown;
  switch (candidate.path[1]) {
    case "setWebCookieHeader": {
      const argument = candidate.argumentList?.length === 1 ? candidate.argumentList[0] : undefined;
      if (argument?.type !== "RAW" || typeof argument.value !== "string" || argument.value.trim() === "") {
        throw new Error("Official web Cookie update payload is invalid");
      }
      webCookieHeader = argument.value;
      value = true;
      break;
    }
    case "setSsoCookieHeader": {
      const argument = candidate.argumentList?.length === 1 ? candidate.argumentList[0] : undefined;
      if (argument?.type !== "RAW" || typeof argument.value !== "string" || argument.value.trim() === "") {
        throw new Error("Official SSO Cookie update payload is invalid");
      }
      ssoCookieHeader = argument.value;
      value = true;
      break;
    }
    case "setOfficialHttpToken": {
      const argument = candidate.argumentList?.length === 1 ? candidate.argumentList[0] : undefined;
      if (argument?.type !== "RAW" || typeof argument.value !== "string" || argument.value.trim() === "") {
        throw new Error("Official HTTP token update payload is invalid");
      }
      officialHttpToken = argument.value;
      value = true;
      break;
    }
    case "beginCaptureOnly":
      networkBoundary.beginCaptureOnly();
      officialWebSocket.disableNetwork();
      value = true;
      break;
    case "drainCapturedRequests":
      value = networkBoundary.drainCapturedRequests();
      break;
    case "drainObservedRequests":
      value = networkBoundary.drainObservedRequests();
      break;
    case "resolveIncomingMedia": {
      const mediaInfo = candidate.argumentList?.[0];
      const context = candidate.argumentList?.[1];
      const accountId = candidate.argumentList?.[2];
      if (
        mediaInfo?.type !== "RAW" ||
        typeof context?.value !== "string" ||
        typeof accountId?.value !== "string"
      ) return true;
      value = await resolveIncomingMedia(mediaInfo.value, context.value, accountId.value);
      break;
    }
    case "syncFriends":
      value = await syncFriends(
        candidate.argumentList?.[0]?.type === "RAW" && typeof candidate.argumentList[0].value === "string"
          ? candidate.argumentList[0].value
          : undefined,
      );
      break;
    default:
      return true;
  }
  parentPort!.postMessage({ id: candidate.id, type: "RAW", value });
  return true;
}

parentPort!.on("message", (message: unknown) => {
  void handleHostControl(message).then((handled) => {
    if (!handled) {
      for (const listener of listenersFor("message")) listener({ data: message });
    }
  }).catch((error: unknown) => {
    const candidate = message as { readonly id?: unknown; readonly path?: unknown };
    if (typeof candidate.id !== "string" || !Array.isArray(candidate.path) || candidate.path[0] !== "__host") {
      for (const listener of listenersFor("message")) listener({ data: message });
      return;
    }
    parentPort!.postMessage({
      id: candidate.id,
      type: "HANDLER",
      name: "throw",
      value: {
        isError: true,
      value: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Official host control failed",
      },
      },
    });
  });
});

const bootstrapSource = patchOfficialBootstrap(
  instrumentOfficialDuplexErrors(readFileSync(bootstrapPath, "utf8")),
  profile.officialWorker.webpackRequireVariable,
);
runInThisContext(bootstrapSource, { filename: bootstrapPath });
const mainAssetSource = readFileSync(mainAssetPath, "utf8");
const mainRuntimeSuffix = `,e=>{e(e.s=${profile.officialWorker.mainRuntimeEntryId})}`;
const mainRuntimeIndex = mainAssetSource.lastIndexOf(mainRuntimeSuffix);
if (mainRuntimeIndex < 0) throw new Error("Pinned main asset does not match the expected registration shape");
const webpackRuntime = officialWebpackRequire() as ((id: string | number) => unknown) & {
  readonly m?: Record<string, unknown>;
};
if (webpackRuntime.m === undefined) throw new Error("Official Webpack module registry is unavailable");
registerOfficialMainAssetWithWorkerExports(
  webpackRuntime.m,
  profile.officialWorker.collidingWorkerModuleIds,
  () => {
  runInThisContext(
    `${mainAssetSource.slice(0, mainRuntimeIndex)}${mainAssetSource.slice(mainRuntimeIndex + mainRuntimeSuffix.length)}`,
    { filename: mainAssetPath },
  );
  },
);
await waitForOfficialBootstrapRegistration();
setImmediate(() => parentPort!.postMessage({ __officialHostReady: true }));
