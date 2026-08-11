import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
import { runInThisContext } from "node:vm";
import "fake-indexeddb/auto";
import { createOfficialNetworkBoundary } from "./official-network.js";

if (parentPort === null) throw new Error("Official messaging Worker host requires a parent port");
const data = workerData as {
  readonly assetDir: string;
  readonly allowNetwork?: boolean;
};
const bootstrapPath = resolve(data.assetDir, "4577c38d10436a1f90f1.chunk.js");
const dynamicChunkPath = resolve(data.assetDir, "269b973c69f9ca2dcc93.chunk.js");
const wasmPath = resolve(data.assetDir, "903641c0ba985b2dcd13.wasm");
const listeners = new Map<string, Set<(event: { readonly data?: unknown }) => void>>();

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
    value: { addEventListener() {}, removeEventListener() {} },
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
const networkBoundary = createOfficialNetworkBoundary(data.allowNetwork, nativeFetch);
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

function handleHostControl(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const candidate = message as {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly path?: unknown;
  };
  if (
    typeof candidate.id !== "string" ||
    candidate.type !== "APPLY" ||
    !Array.isArray(candidate.path) ||
    candidate.path[0] !== "__host"
  ) return false;
  let value: unknown;
  switch (candidate.path[1]) {
    case "beginCaptureOnly":
      networkBoundary.beginCaptureOnly();
      value = true;
      break;
    case "drainCapturedRequests":
      value = networkBoundary.drainCapturedRequests();
      break;
    default:
      return false;
  }
  parentPort!.postMessage({ id: candidate.id, type: "RAW", value });
  return true;
}

parentPort!.on("message", (message: unknown) => {
  if (handleHostControl(message)) return;
  for (const listener of listenersFor("message")) listener({ data: message });
});

runInThisContext(readFileSync(bootstrapPath, "utf8"), { filename: bootstrapPath });
setImmediate(() => parentPort!.postMessage({ __officialHostReady: true }));
