import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import type { ChatMessage, CryptoStateExport } from "./content-types.js";
import { captureOfficialChatEnvelope } from "./official-chat-capture.js";
import { OfficialWorkerClient, exposeOfficial, type OfficialRemote } from "./official-worker-client.js";
import { OfficialPhotoContentBuilder, type OfficialPhotoMessageContent } from "./official-photo-content.js";
import { uploadOfficialPhotoContent } from "../media/official-upload.js";
import { GrpcWebClient } from "../transport/grpc-client.js";
import { beginOfficialCaptureOnly, drainOfficialCapturedRequests } from "./official-host-control.js";
import { extractCapturedContent, isCapturedCreateContentMessage } from "./official-captured-content.js";

if (parentPort === null) throw new Error("Content runtime Worker requires a parent port");

const data = workerData as {
  readonly assetDir?: string;
  readonly allowNetwork?: boolean;
} | undefined;
let adapter: BuildAdapter | undefined;
let officialRuntime: OfficialWorkerClient | undefined;
let officialConversationManager: OfficialRemote | undefined;
let installedGlobals: InstalledGlobals | undefined;
let photoBuilder: OfficialPhotoContentBuilder | undefined;
let photoUploadError: AppError | undefined;
let chatSyncError: AppError | undefined;
const chatMessages: ChatMessage[] = [];

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
    const nextPhotoBuilder = new OfficialPhotoContentBuilder(
      await readFile(join(data.assetDir, "41f8a232e0dafca526c7.js"), "utf8"),
    );
    const mediaGrpc = new GrpcWebClient({
      auth: {
        getRequestAuth: async () => ({
          httpToken: session.auth.httpToken,
          cookieHeader: session.auth.cookieHeader,
          headers: session.auth.requestHeaders,
        }),
        refreshOnce: async () => {
          throw new AppError(
            "SESSION_REEXPORT_REQUIRED",
            "Photo upload authentication expired inside the content runtime",
          );
        },
      },
    });
    const contentDelegate = {
      uploadMedia: async (
        content: OfficialPhotoMessageContent,
        _unused: unknown,
        callback: OfficialRemote,
      ) => {
        try {
          if (data.allowNetwork !== true) {
            throw new AppError("UPLOAD_FAILED", "Photo upload network access is disabled");
          }
          const finalized = await uploadOfficialPhotoContent(content, {
            builder: nextPhotoBuilder,
            grpc: mediaGrpc,
          });
          await callback.call(["onUploadFinished"], [
            [nextPhotoBuilder.uploadResult(finalized.remoteMediaReferences, true)],
            finalized.content,
          ]);
        } catch (error) {
          photoUploadError = error instanceof AppError
            ? error
            : new AppError("UPLOAD_FAILED", "Official photo upload delegate failed", {
                errorName: error instanceof Error ? error.name : "UnknownError",
              });
          await callback.call(["onUploadFinished"], [
            [nextPhotoBuilder.uploadResult(undefined, false)],
            content,
          ]).catch(() => undefined);
        }
      },
      uploadMediaReferences: () => undefined,
    };
    const noop = () => undefined;
    const conversationDelegate = {
      onConversationCreated: noop,
      onConversationUpdated: (
        _current: unknown,
        _metadata: unknown,
        messages: unknown,
      ) => {
        if (Array.isArray(messages)) {
          chatMessages.push(...nextPhotoBuilder.decodeChatMessages(messages));
        }
      },
      onSendStarted: noop,
      onSendComplete: noop,
      onConversationRemoved: noop,
      onConversationCreationServerConfirmed: noop,
      onConversationReset: noop,
    };
    const feedDelegate = {
      onFeedEntriesUpdated: noop,
      onInternalSyncFeed: noop,
      onFeedRequestError: (_request: unknown, status: unknown) => {
        chatSyncError = nextPhotoBuilder.isUnauthorizedCallbackStatus(status)
          ? new AppError("SESSION_EXPIRED", "Official message synchronization was unauthorized")
          : new AppError("GRPC_FAILED", "Official message synchronization failed");
      },
    };
    const nextOfficialRuntime = new OfficialWorkerClient({
      assetDir: data.assetDir,
      allowNetwork: data.allowNetwork === true,
      contentDelegate,
      conversationDelegate,
      feedDelegate,
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
    photoBuilder = nextPhotoBuilder;
    return { buildId: "8dd50222", initializedAt: new Date().toISOString() };
  } catch (error) {
    installedGlobals.restore();
    installedGlobals = undefined;

    throw error;
  }
}

async function createOfficialPhotoSnap(
  input: Extract<RuntimeRequest, { method: "createPhotoSnap" }>["input"],
): Promise<unknown> {
  if (officialRuntime === undefined || officialConversationManager === undefined || photoBuilder === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing login-time messaging key initialization state",
    );
  }
  photoUploadError = undefined;
  const prepared = await photoBuilder.prepare(input);
  await beginOfficialCaptureOnly(officialRuntime);
  let sendError: AppError | undefined;
  void officialConversationManager.call<void>(["sendMessageWithContent"], [
    prepared.destination,
    prepared.content,
    exposeOfficial({
      onSuccess: () => undefined,
      onQueued: () => undefined,
      onError: () => {
        sendError = new AppError("CRYPTO_RUNTIME_FAILED", "Official photo message creation failed");
      },
    }),
  ]).catch((error: unknown) => {
    sendError = error instanceof AppError
      ? error
      : new AppError("CRYPTO_RUNTIME_FAILED", "Official photo message creation failed");
  });

  const startedAt = Date.now();
  const captured = [];
  while (Date.now() - startedAt <= 60_000) {
    captured.push(...await drainOfficialCapturedRequests(officialRuntime));
    if (captured.some(isCapturedCreateContentMessage)) {
      return extractCapturedContent(captured, "photo-snap");
    }
    if (photoUploadError !== undefined) throw photoUploadError;
    if (sendError !== undefined) throw sendError;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new AppError(
    "CRYPTO_RUNTIME_FAILED",
    "Official messaging runtime did not produce a photo CreateContentMessage request",
    { timeoutMs: 60_000 },
  );
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
        { prepareChat: (input) => photoBuilder!.prepareChat(input) },
      );
    case "decryptChat":
      return requireAdapter().decryptChat(request.input);
    case "createPhotoSnap":
      return createOfficialPhotoSnap(request.input);
    case "refreshAuth":
      return requireAdapter().refreshAuth();
    case "exportState":
      return exportRuntimeState();
    case "syncMessages":
      if (officialRuntime === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      chatSyncError = undefined;
      return officialRuntime.syncFeed(0);
    case "drainChatMessages":
      if (chatSyncError !== undefined) {
        const error = chatSyncError;
        chatSyncError = undefined;
        throw error;
      }
      return chatMessages.splice(0);
    case "shutdown":
      await officialRuntime?.shutdown();
      installedGlobals?.restore();
      installedGlobals = undefined;
      adapter = undefined;
      officialRuntime = undefined;
      officialConversationManager = undefined;
      photoBuilder = undefined;
      photoUploadError = undefined;
      chatSyncError = undefined;
      chatMessages.splice(0);
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
