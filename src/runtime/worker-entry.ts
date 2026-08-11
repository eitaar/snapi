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
import { exportIndexedDbSnapshot, importIndexedDbSnapshot } from "./indexeddb-snapshot.js";
import type { RuntimeRequest, RuntimeResponse, SerializedAppError } from "./protocol.js";
import type { CryptoStateExport } from "./content-types.js";
import { captureOfficialChatEnvelope } from "./official-chat-capture.js";
import { OfficialWorkerClient, type OfficialRemote } from "./official-worker-client.js";

if (parentPort === null) throw new Error("Content runtime Worker requires a parent port");

const data = workerData as {
  readonly assetDir?: string;
  readonly allowNetwork?: boolean;
} | undefined;
let adapter: BuildAdapter | undefined;
let officialRuntime: OfficialWorkerClient | undefined;
let officialConversationManager: OfficialRemote | undefined;
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
  if (officialRuntime !== undefined) throw new AppError("WORKER_PROTOCOL_ERROR", "Content runtime is already initialized");
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
    const nextOfficialRuntime = new OfficialWorkerClient({
      assetDir: data.assetDir,
      allowNetwork: data.allowNetwork === true,
    });
    try {
      await nextOfficialRuntime.initializeWasm(session);
    } catch (error) {
      await nextOfficialRuntime.shutdown().catch(() => undefined);
      throw error;
    }
    if (session.messaging !== undefined) {
      officialConversationManager = await nextOfficialRuntime.initializeMessagingSession(session);
    }
    officialRuntime = nextOfficialRuntime;
    return { buildId: "8dd50222", initializedAt: new Date().toISOString() };
  } catch (error) {
    installedGlobals.restore();
    installedGlobals = undefined;

    throw error;
  }
}

async function exportRuntimeState(): Promise<CryptoStateExport> {
  if (officialRuntime === undefined || installedGlobals === undefined) {
    throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
  }
  const databaseNames = (await installedGlobals.indexedDB.databases())
    .flatMap(({ name }) => name === undefined ? [] : [name]);
  const messagingState = officialRuntime.exportMessagingState();
  return {
    localStorage: messagingState.localStorage,
    sessionStorage: messagingState.sessionStorage,
    ...(messagingState.rootWrappingKey === undefined
      ? {}
      : { rootWrappingKey: messagingState.rootWrappingKey }),
    indexedDb: await exportIndexedDbSnapshot(
      databaseNames,
      installedGlobals.indexedDB,
    ),
  };
}

async function dispatch(request: RuntimeRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return initialize(request);
    case "encryptChat":
      if (officialRuntime === undefined || officialConversationManager === undefined) {
        throw new AppError(
          "SESSION_REEXPORT_REQUIRED",
          "Session export is missing login-time messaging key initialization state",
        );
      }
      return captureOfficialChatEnvelope(
        officialRuntime,
        officialConversationManager,
        request.input,
      );
    case "decryptChat":
      return requireAdapter().decryptChat(request.input);
    case "createPhotoSnap":
      return requireAdapter().createPhotoSnap(request.input);
    case "refreshAuth":
      return requireAdapter().refreshAuth();
    case "exportState":
      return exportRuntimeState();
    case "shutdown":
      await officialRuntime?.shutdown();
      installedGlobals?.restore();
      installedGlobals = undefined;
      adapter = undefined;
      officialRuntime = undefined;
      officialConversationManager = undefined;
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
    const content = value as {
      bytes: Uint8Array;
      createContentMessagePayload?: unknown;
    };
    return [
      content.bytes.buffer as ArrayBuffer,
      ...(content.createContentMessagePayload instanceof Uint8Array
        ? [content.createContentMessagePayload.buffer as ArrayBuffer]
        : []),
    ];
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
