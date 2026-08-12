import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
import { runInThisContext } from "node:vm";
import tls from "node:tls";

if (parentPort === null) throw new Error("Web Attestation Worker requires a parent port");

const data = workerData as {
  readonly accountId: string;
  readonly assetDir: string;
  readonly wasmUrl: string;
};
const queueName = "webpackChunk_snapchat_web_calling_app";
const attestationWasmSha256 = "f22b03552274b5b36b01278547ab4c9c31f469aa09b89ece2ed52a04d752ed00";
const attestationWasmSize = 849_474;

interface WebpackRequire {
  (id: string | number): unknown;
  readonly m: Record<string, unknown>;
}

function workerError(
  code: "AUTH_CONTEXT_UNAVAILABLE" | "UNSUPPORTED_BUILD",
  errorName: string,
  errorMessage = "",
): void {
  parentPort!.postMessage({
    type: "error",
    code,
    errorName,
    errorMessage: errorMessage.replace(/[A-Za-z0-9._~-]{24,}/g, "<redacted>").slice(0, 160),
  });
}

function patchNodeModules(source: string): string {
  const withHash = source.replace("2013(){}", "2013(e,t){t.createHash=globalThis.createHash}");
  const withBuffer = withHash.replace("91903(){}", "91903(e,t){t.Buffer=Buffer}");
  if (withBuffer === source) throw new Error("official attestation bundle bridge anchors are missing");
  return withBuffer;
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

function createElement(tagName: string): Record<string, unknown> {
  return {
    tagName: tagName.toUpperCase(),
    style: {},
    setAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getContext() { return null; },
  };
}

class NodeXmlHttpRequest {
  static readonly HEADERS_RECEIVED = 2;
  readyState = 0;
  status = 0;
  response = "";
  responseType = "";
  responseURL = "";
  withCredentials = false;
  onreadystatechange: (() => void) | undefined;
  onload: (() => void) | undefined;
  onerror: (() => void) | undefined;
  private readonly headers = new Headers();
  private method = "GET";
  private url = "";

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.responseURL = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
  overrideMimeType(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  getAllResponseHeaders(): string { return ""; }
  abort(): void {}

  send(body?: BodyInit | null): void {
    fetch(this.url, { method: this.method, headers: this.headers, body: body ?? null })
      .then(async (response) => {
        this.status = response.status;
        this.readyState = NodeXmlHttpRequest.HEADERS_RECEIVED;
        this.onreadystatechange?.();
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.response = String.fromCharCode(...bytes);
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}

function installBrowserShims(): void {
  const target = globalThis as unknown as Record<PropertyKey, unknown>;
  const document = {
    addEventListener() {},
    removeEventListener() {},
    createElement,
    body: { appendChild() {}, removeChild() {} },
    head: { appendChild() {}, removeChild() {} },
    documentElement: { appendChild() {}, removeChild() {} },
  };
  target.addEventListener = () => {};
  target.removeEventListener = () => {};
  Object.defineProperties(target, {
    self: { value: target, configurable: true, writable: true },
    window: { value: target, configurable: true, writable: true },
    WorkerGlobalScope: { value: Object, configurable: true, writable: true },
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
      value: { origin: "https://web.snapchat.com", href: "https://web.snapchat.com/web/", pathname: "/web/" },
      configurable: true,
      writable: true,
    },
    screen: {
      value: { availHeight: 900, availWidth: 1440, height: 900, width: 1440, colorDepth: 24, pixelDepth: 24 },
      configurable: true,
      writable: true,
    },
    devicePixelRatio: { value: 1, configurable: true, writable: true },
    document: { value: document, configurable: true, writable: true },
    localStorage: { value: createStorage(), configurable: true, writable: true },
    sessionStorage: { value: createStorage(), configurable: true, writable: true },
    MessageChannel: { value: MessageChannel, configurable: true, writable: true },
    XMLHttpRequest: { value: NodeXmlHttpRequest, configurable: true, writable: true },
  });
}

async function verifiedAttestationWasm(response: Response): Promise<Response> {
  if (!response.ok) throw new Error("attestation wasm download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== attestationWasmSize || hash !== attestationWasmSha256) {
    throw new Error("attestation wasm verification failed");
  }
  return new Response(bytes, { status: 200, headers: { "content-type": "application/wasm" } });
}

async function main(): Promise<void> {
  tls.setDefaultCACertificates(tls.getCACertificates("system"));
  installBrowserShims();
  const target = globalThis as unknown as Record<PropertyKey, unknown>;
  target.Buffer = Buffer;
  target.createHash = createHash;
  const nativeFetch = globalThis.fetch;
  Object.defineProperty(target, "fetch", {
    value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === data.wasmUrl) return verifiedAttestationWasm(await nativeFetch(input, init));
      return nativeFetch(input, init);
    },
    configurable: true,
  });

  const bootstrapPath = resolve(data.assetDir, "4577c38d10436a1f90f1.chunk.js");
  const dynamicPath = resolve(data.assetDir, "269b973c69f9ca2dcc93.chunk.js");
  const mainPath = resolve(data.assetDir, "41f8a232e0dafca526c7.js");
  Object.defineProperty(target, "importScripts", {
    value: (...urls: readonly string[]) => {
      for (const url of urls) {
        if (!url.includes("269b973c69f9ca2dcc93.chunk.js")) throw new Error("unverified dynamic chunk requested");
        runInThisContext(readFileSync(dynamicPath, "utf8"), { filename: dynamicPath });
      }
    },
    configurable: true,
  });
  runInThisContext(patchNodeModules(readFileSync(bootstrapPath, "utf8")), { filename: bootstrapPath });

  let webpackRequire: WebpackRequire | undefined;
  const queue = (target[queueName] as { push: (value: unknown) => void });
  queue.push([[0], {}, (runtime: unknown) => { webpackRequire = runtime as WebpackRequire; }]);
  if (webpackRequire === undefined) throw new Error("official webpack runtime was not initialized");
  webpackRequire.m["91903"] = (_module: unknown, exports: { Buffer?: typeof Buffer }) => { exports.Buffer = Buffer; };
  webpackRequire.m["2013"] = (_module: unknown, exports: { createHash?: typeof createHash }) => { exports.createHash = createHash; };
  const originalPush = queue.push.bind(queue);
  queue.push = (value: unknown) => {
    const chunk = value as readonly unknown[];
    originalPush([chunk[0], chunk[1]]);
  };
  runInThisContext(patchNodeModules(readFileSync(mainPath, "utf8")), { filename: mainPath });

  const attestationModule = webpackRequire(80644) as {
    createModule?: (wasmUrl: string, page: string) => Promise<{
      AttestationSession?: { instance(): { finalize(accountId: string): Promise<unknown> } };
    }>;
  };
  if (typeof attestationModule.createModule !== "function") throw new Error("official attestation module is unavailable");
  const initialized = await attestationModule.createModule(data.wasmUrl, "dweb");
  const session = initialized.AttestationSession;
  if (session === undefined) throw new Error("official attestation session is unavailable");
  const proof = await session.instance().finalize(data.accountId);
  if (typeof proof !== "string" || proof.trim() === "") throw new Error("official attestation returned no proof");
  parentPort!.postMessage({ type: "result", value: proof });
}

try {
  await main();
} catch (error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  workerError(
    message.includes("verification") || message.includes("official") ? "UNSUPPORTED_BUILD" : "AUTH_CONTEXT_UNAVAILABLE",
    name,
    message,
  );
}
