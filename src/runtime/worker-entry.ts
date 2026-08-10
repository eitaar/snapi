import { parentPort, workerData } from "node:worker_threads";
import { AppError } from "../errors.js";
import { redact } from "../logging/redact.js";
import { parseSessionExport } from "../session/schema.js";
import { AssetLoader } from "../compat/asset-loader.js";
import { CompatibilityGuard, SUPPORTED_ASSETS } from "../compat/guard.js";
import { captureWebpackModules } from "../compat/module-scanner.js";
import type { ModuleFactory } from "../compat/types.js";
import type { BuildAdapter } from "./build-adapter.js";
import { installBrowserGlobals, type InstalledGlobals } from "./browser-globals.js";
import { createBuild8dd50222Adapter } from "./builds/8dd50222.js";
import { importIndexedDbSnapshot } from "./indexeddb-snapshot.js";
import type { RuntimeRequest, RuntimeResponse, SerializedAppError } from "./protocol.js";

if (parentPort === null) throw new Error("Content runtime Worker requires a parent port");

const data = workerData as { readonly assetDir?: string } | undefined;
let adapter: BuildAdapter | undefined;
let installedGlobals: InstalledGlobals | undefined;

function asSerializedError(error: unknown): SerializedAppError {
  const appError = error instanceof AppError
    ? error
    : new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime operation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
  const details = redact(appError.details);
  return {
    code: appError.code,
    message: appError.message,
    details: details !== null && typeof details === "object" && !Array.isArray(details)
      ? details as Readonly<Record<string, unknown>>
      : {},
  };
}

function requireAdapter(): BuildAdapter {
  if (adapter === undefined) throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
  return adapter;
}

async function initialize(request: Extract<RuntimeRequest, { method: "initialize" }>): Promise<unknown> {
  if (adapter !== undefined) throw new AppError("WORKER_PROTOCOL_ERROR", "Content runtime is already initialized");
  if (data?.assetDir === undefined) {
    throw new AppError("INVALID_CONFIG", "Worker asset directory is required");
  }
  const session = parseSessionExport(request.session);
  installedGlobals = installBrowserGlobals({
    origin: "https://www.snapchat.com",
    userAgent: "Mozilla/5.0 SnapchatWeb/8dd50222",
    localStorage: session.localStorage,
  });
  try {
    await importIndexedDbSnapshot(session.indexedDb, installedGlobals.indexedDB);
    const loader = new AssetLoader(data.assetDir);
    await new CompatibilityGuard(loader).verify(session);
    const assets = new Map<string, Uint8Array>();
    for (const record of SUPPORTED_ASSETS) assets.set(record.filename, await loader.loadVerified(record));

    const wasmRecord = SUPPORTED_ASSETS.find(({ kind }) => kind === "wasm")!;
    const wasmModule = new WebAssembly.Module(Uint8Array.from(assets.get(wasmRecord.filename)!));
    const imports = WebAssembly.Module.imports(wasmModule);
    if (imports.length !== 0) {
      throw new AppError("UNSUPPORTED_BUILD", "WASM imports require a verified build-specific binding", {
        wasmImports: imports.map(({ module, name, kind }) => `${module}.${name}:${kind}`),
      });
    }
    const wasmInstance = new WebAssembly.Instance(wasmModule);
    const modules = new Map<string, ModuleFactory>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const record of SUPPORTED_ASSETS.filter(({ kind }) => kind === "javascript")) {
      for (const [id, factory] of captureWebpackModules(decoder.decode(assets.get(record.filename)!))) {
        modules.set(id, factory);
      }
    }
    const nextAdapter = createBuild8dd50222Adapter();
    await nextAdapter.initialize({ session, assets, modules, wasmInstance });
    adapter = nextAdapter;
    return { buildId: "8dd50222", initializedAt: new Date().toISOString() };
  } catch (error) {
    installedGlobals.restore();
    installedGlobals = undefined;
    throw error;
  }
}

async function dispatch(request: RuntimeRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return initialize(request);
    case "encryptChat":
      return requireAdapter().encryptChat(request.input);
    case "decryptChat":
      return requireAdapter().decryptChat(request.input);
    case "createPhotoSnap":
      return requireAdapter().createPhotoSnap(request.input);
    case "refreshAuth":
      return requireAdapter().refreshAuth();
    case "exportState":
      return requireAdapter().exportState();
    case "shutdown":
      installedGlobals?.restore();
      installedGlobals = undefined;
      adapter = undefined;
      return undefined;
  }
}

function transferList(value: unknown): ArrayBuffer[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "bytes" in value &&
    (value as { bytes?: unknown }).bytes instanceof Uint8Array
  ) {
    return [(value as { bytes: Uint8Array }).bytes.buffer as ArrayBuffer];
  }
  return [];
}

async function handle(value: unknown): Promise<void> {
  const candidate = value as Partial<RuntimeRequest>;
  if (!Number.isSafeInteger(candidate.id) || typeof candidate.method !== "string") {
    throw new AppError("WORKER_PROTOCOL_ERROR", "Worker request is malformed");
  }
  const request = value as RuntimeRequest;
  let response: RuntimeResponse;
  let transfers: ArrayBuffer[] = [];
  try {
    const result = await dispatch(request);
    response = { id: request.id, ok: true, value: result };
    transfers = transferList(result);
  } catch (error) {
    response = { id: request.id, ok: false, error: asSerializedError(error) };
  }
  parentPort!.postMessage(response, transfers);
  if (request.method === "shutdown") parentPort!.close();
}

let queue = Promise.resolve();
parentPort.on("message", (value: unknown) => {
  queue = queue.then(() => handle(value)).catch((error: unknown) => {
    const response: RuntimeResponse = {
      id: Number.isSafeInteger((value as { id?: unknown }).id) ? (value as { id: number }).id : -1,
      ok: false,
      error: asSerializedError(error),
    };
    parentPort!.postMessage(response);
  });
});
