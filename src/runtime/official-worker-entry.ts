import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
import { runInThisContext } from "node:vm";
import "fake-indexeddb/auto";
import { createOfficialNetworkBoundary } from "./official-network.js";
import { serializeOfficialFriendState } from "./official-friend-snapshot.js";

if (parentPort === null) throw new Error("Official messaging Worker host requires a parent port");
const data = workerData as {
  readonly assetDir: string;
  readonly allowNetwork?: boolean;
};
const bootstrapPath = resolve(data.assetDir, "4577c38d10436a1f90f1.chunk.js");
const dynamicChunkPath = resolve(data.assetDir, "269b973c69f9ca2dcc93.chunk.js");
const mainAssetPath = resolve(data.assetDir, "41f8a232e0dafca526c7.js");
const wasmPath = resolve(data.assetDir, "903641c0ba985b2dcd13.wasm");
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
  self: { value: globalThis, configurable: true, writable: true },
  window: { value: globalThis, configurable: true, writable: true },
  WorkerGlobalScope: { value: Object, configurable: true, writable: true },
  process: { value: undefined, configurable: true, writable: true },
  navigator: {
    value: {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0 SnapchatWeb/8dd50222",
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
      value: "https://cf-st.sc-cdn.net/dw/903641c0ba985b2dcd13.wasm",
    });
  }
}
Object.defineProperty(target, "Response", { value: AssetResponse, configurable: true, writable: true });

const nativeFetch = fetch;
const networkBoundary = createOfficialNetworkBoundary(data.allowNetwork, nativeFetch, {
  webCookieHeader: () => webCookieHeader,
  ssoCookieHeader: () => ssoCookieHeader,
});
Object.defineProperty(target, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("903641c0ba985b2dcd13.wasm")) {
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
        if (!url.includes("269b973c69f9ca2dcc93.chunk.js")) {
          throw new Error("Official messaging Worker requested an unverified dynamic chunk");
        }
        runInThisContext(readFileSync(dynamicChunkPath, "utf8"), { filename: dynamicChunkPath });
      }
    },
    configurable: true,
  },
});

function officialWebpackRequire(): ((id: string | number) => unknown) {
  const require = target.__officialWebpackRequire;
  if (typeof require !== "function") throw new Error("Official Webpack runtime is unavailable");
  return require as (id: string | number) => unknown;
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
    const authStore = (require("78425") as {
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
  const resolved = [];
  for (const layer of layers) {
    if (typeof layer.dataUrl !== "string") throw new Error("Official media resolver returned no URL");
    const response = await nativeFetch(layer.dataUrl);
    if (!response.ok) throw new Error(`Official media download failed with status ${response.status}`);
    resolved.push({
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      ...(typeof layer.mediaLayerType === "number" ? { mediaLayerType: layer.mediaLayerType } : {}),
      hasAudio: Boolean(layer.hasAudio),
      ...(typeof layer.width === "number" ? { width: layer.width } : {}),
      ...(typeof layer.height === "number" ? { height: layer.height } : {}),
    });
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(layer.dataUrl);
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
    const store = officialWebpackRequire()("78425") as {
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
    try {
      await (before as { syncFriends: () => Promise<void> }).syncFriends();
    } catch (error) {
      const observed = networkBoundary.drainObservedRequests();
      const summary = observed.map((request) => {
        const pathname = (() => {
          try { return new URL(request.path).pathname; } catch { return "<invalid-path>"; }
        })();
        const result = request.responseStatus === undefined
          ? [request.errorReason, request.errorCode].filter(
            (value): value is string => value !== undefined,
          ).join(" ") || "no-response"
          : String(request.responseStatus);
        return `${request.method} ${pathname} ${result}`;
      }).join(", ");
      throw new Error(
        `Official friend sync failed: ${error instanceof Error ? error.message : "unknown error"}${summary === "" ? "" : ` [${summary}]`}`,
      );
    }
    stage = "serialize-friends";
    const user = userStore?.getState().user;
    return serializeOfficialFriendState(user, new Date().toISOString());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Official friend sync failed:")) throw error;
    const stack = error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\n").slice(0, 4).join(" <- ")
      : "";
    throw new Error(
      `Official friend sync failed at ${stage}: ${error instanceof Error ? error.message : "unknown error"}` +
      (stack === "" ? "" : ` [stack=${stack}]`),
    );
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

let bootstrapSource = readFileSync(bootstrapPath, "utf8");
const runtimeHelperBridge = "s.r=e=>{typeof Symbol!==\"undefined\"&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:\"Module\"}),Object.defineProperty(e,\"__esModule\",{value:!0})},s.nmd=e=>(e.paths=[],e.children||(e.children=[]),e),s.t=(e,t)=>{if(1&t&&(e=s(e)),8&t)return e;if(\"object\"==typeof e&&e){if(4&t&&e.__esModule)return e;if(16&t&&\"function\"==typeof e.then)return e}const n=Object.create(null);s.r(n);const r={};for(let o=2&t&&e;o&&\"object\"==typeof o&&!Object.prototype.hasOwnProperty.call(o,\"__esModule\");o=Object.getPrototypeOf(o)){const e=o;for(const t of Object.getOwnPropertyNames(e))r[t]=()=>e[t]}r.default=()=>e,s.d(n,r);return n},s.g=globalThis";
bootstrapSource = bootstrapSource.replace(
  "t=s.x,s.x=()=>",
  `${runtimeHelperBridge},globalThis.__officialWebpackRequire=s,t=s.x,s.x=()=>`,
);
bootstrapSource = bootstrapSource.replace(
  "un.wasmModule=c,un.wasmModuleCleanup=u",
  "un.wasmModule=c,globalThis.__officialWasmModule=c,un.wasmModuleCleanup=u",
);
if (!bootstrapSource.includes("__officialWebpackRequire") || !bootstrapSource.includes("__officialWasmModule")) {
  throw new Error("Official bootstrap does not match the pinned Webpack bridge shape");
}
runInThisContext(bootstrapSource, { filename: bootstrapPath });
const mainAssetSource = readFileSync(mainAssetPath, "utf8");
const mainRuntimeSuffix = ",e=>{e(e.s=28420)}";
const mainRuntimeIndex = mainAssetSource.lastIndexOf(mainRuntimeSuffix);
if (mainRuntimeIndex < 0) throw new Error("Pinned main asset does not match the expected registration shape");
runInThisContext(
  `${mainAssetSource.slice(0, mainRuntimeIndex)}${mainAssetSource.slice(mainRuntimeIndex + mainRuntimeSuffix.length)}`,
  { filename: mainAssetPath },
);
setImmediate(() => parentPort!.postMessage({ __officialHostReady: true }));
