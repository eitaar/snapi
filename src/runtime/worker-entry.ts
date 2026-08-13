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
import type { ChatMessage, CryptoStateExport, IncomingSnap, IncomingSnapMedia } from "./content-types.js";
import { buildEasyFriendSnapshot } from "../friends/snapshot.js";
import { captureOfficialChatEnvelope } from "./official-chat-capture.js";
import { OfficialWorkerClient, exposeOfficial, type OfficialRemote } from "./official-worker-client.js";
import { OfficialPhotoContentBuilder, type OfficialPhotoMessageContent } from "./official-photo-content.js";
import type { OfficialIncomingSnapCandidate } from "./official-incoming-snap.js";
import { uploadOfficialPhotoContent } from "../media/official-upload.js";
import { GrpcWebClient } from "../transport/grpc-client.js";
import { beginOfficialCaptureOnly, drainOfficialCapturedRequests } from "./official-host-control.js";
import { extractCapturedContent, isCapturedCreateContentMessage } from "./official-captured-content.js";
import { RuntimeRequestAuth } from "./runtime-request-auth.js";
import { MessagingInitializationState } from "./messaging-initialization-state.js";
import {
  IncomingSnapQueue,
  MAX_RESOLVED_BYTES_PER_SNAP,
  MAX_RESOLVED_LAYERS_PER_SNAP,
} from "./incoming-snap-queue.js";

if (parentPort === null) throw new Error("Content runtime Worker requires a parent port");

const data = workerData as {
  readonly assetDir?: string;
  readonly allowNetwork?: boolean;
} | undefined;
let adapter: BuildAdapter | undefined;
let officialRuntime: OfficialWorkerClient | undefined;
const messagingInitialization = new MessagingInitializationState();
let installedGlobals: InstalledGlobals | undefined;
let photoBuilder: OfficialPhotoContentBuilder | undefined;
let photoRequestAuth: RuntimeRequestAuth | undefined;
let photoUploadError: AppError | undefined;
let chatSyncError: AppError | undefined;
const chatMessages: ChatMessage[] = [];
const incomingSnapQueue = new IncomingSnapQueue();

async function resolveIncomingSnap(
  runtime: OfficialWorkerClient,
  snap: OfficialIncomingSnapCandidate,
): Promise<IncomingSnap> {
  const media: IncomingSnapMedia[] = [];
  let totalBytes = 0;
  let totalLayers = 0;
  for (const mediaInfo of snap.mediaInfos) {
    const layers = await runtime.resolveIncomingMedia(mediaInfo, "chat_playback");
    totalLayers += layers.length;
    if (totalLayers > MAX_RESOLVED_LAYERS_PER_SNAP) {
      throw new AppError(
        "CRYPTO_RUNTIME_FAILED",
        "Incoming Snap exceeded the resolved layer limit",
        { maxLayers: MAX_RESOLVED_LAYERS_PER_SNAP },
      );
    }
    for (const layer of layers) {
      totalBytes += layer.bytes.byteLength;
      if (totalBytes > MAX_RESOLVED_BYTES_PER_SNAP) {
        throw new AppError(
          "CRYPTO_RUNTIME_FAILED",
          "Incoming Snap exceeded the resolved byte limit",
          { maxBytes: MAX_RESOLVED_BYTES_PER_SNAP },
        );
      }
      media.push({
        bytes: layer.bytes,
        mimeType: layer.mimeType,
        ...(typeof layer.width === "number" ? { width: layer.width } : {}),
        ...(typeof layer.height === "number" ? { height: layer.height } : {}),
        hasAudio: layer.hasAudio,
      });
    }
  }
  return {
    type: "snap.received",
    senderId: snap.senderId,
    conversationId: snap.conversationId,
    messageId: snap.messageId,
    timestamp: snap.timestamp,
    media,
  };
}

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

function canContinueWithoutMessaging(error: unknown): boolean {
  return error instanceof AppError && (
    (typeof error.details.safeMessage === "string" &&
      error.details.safeMessage.startsWith("failed to create duplex client")) ||
    error.message === "Official messaging Worker call failed"
  );
}

async function initialize(request: Extract<RuntimeRequest, { method: "initialize" }>): Promise<unknown> {
  if (officialRuntime !== undefined) throw new AppError("WORKER_PROTOCOL_ERROR", "Content runtime is already initialized");
  if (data?.assetDir === undefined) {
    throw new AppError("INVALID_CONFIG", "Worker asset directory is required");
  }
  const session = parseSessionExport(request.session);
  messagingInitialization.reset();
  let initializationStage = "browser-state";
  installedGlobals = installBrowserGlobals({
    origin: "https://www.snapchat.com",
    userAgent: "Mozilla/5.0 SnapchatWeb/8dd50222",
    localStorage: session.localStorage,
  });
  try {
    await importIndexedDbSnapshot(session.indexedDb, installedGlobals.indexedDB);
    initializationStage = "asset-verification";
    const loader = new AssetLoader(data.assetDir);
    await new CompatibilityGuard(loader).verify(session);
    const nextPhotoBuilder = new OfficialPhotoContentBuilder(
      await readFile(join(data.assetDir, "41f8a232e0dafca526c7.js"), "utf8"),
    );
    const nextPhotoRequestAuth = new RuntimeRequestAuth(session);
    const mediaGrpc = new GrpcWebClient({
      auth: nextPhotoRequestAuth,
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
    let callbackRuntime: OfficialWorkerClient | undefined;
    const conversationDelegate = {
      onConversationCreated: noop,
      onConversationUpdated: (
        _current: unknown,
        _metadata: unknown,
        messages: unknown,
      ) => {
        if (Array.isArray(messages)) {
          chatMessages.push(...nextPhotoBuilder.decodeChatMessages(messages));
          const incomingSnaps = nextPhotoBuilder.decodeIncomingSnapMessages(messages);
          if (callbackRuntime !== undefined) incomingSnapQueue.enqueue(incomingSnaps);
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
    callbackRuntime = nextOfficialRuntime;
    try {
      initializationStage = "official-wasm";
      await nextOfficialRuntime.initializeWasm(session);
    } catch (error) {
      await nextOfficialRuntime.shutdown().catch(() => undefined);
      throw error;
    }
    if (session.messaging !== undefined) {
      try {
        initializationStage = "messaging-session";
        messagingInitialization.setManager(await nextOfficialRuntime.initializeMessagingSession(session));
      } catch (error) {
        if (!canContinueWithoutMessaging(error)) throw error;
        messagingInitialization.retain(error);
      }
    }
    officialRuntime = nextOfficialRuntime;
    photoBuilder = nextPhotoBuilder;
    photoRequestAuth = nextPhotoRequestAuth;
    return { buildId: "8dd50222", initializedAt: new Date().toISOString() };
  } catch (error) {
    installedGlobals.restore();
    installedGlobals = undefined;
    if (error instanceof AppError) {
      throw new AppError(error.code, error.message, {
        ...error.details,
        initializationStage,
      });
    }
    throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime initialization failed", {
      initializationStage,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function createOfficialPhotoSnap(
  input: Extract<RuntimeRequest, { method: "createPhotoSnap" }>["input"],
): Promise<unknown> {
  if (officialRuntime === undefined || photoBuilder === undefined) {
    throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
  }
  const officialConversationManager = messagingInitialization.require();
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
    case "updateAuth":
      if (officialRuntime === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      await officialRuntime.updateAuth(request.auth);
      photoRequestAuth?.update(request.auth);
      return undefined;
    case "encryptChat":
      if (officialRuntime === undefined || photoBuilder === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      const officialConversationManager = messagingInitialization.require();
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
    case "setSnapWatchActive":
      incomingSnapQueue.setActive(request.active);
      return undefined;
    case "syncFriends":
      if (officialRuntime === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      return officialRuntime.syncFriends();
    case "syncFriendsForSending":
      if (officialRuntime === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      {
        const snapshot = await officialRuntime.syncFriends();
        const friendIds = snapshot.friends
          .filter((friend) => friend.status === "friend")
          .map((friend) => friend.userId);
        const conversationIds = await officialRuntime.getOneOnOneConversationIds(friendIds);
        return buildEasyFriendSnapshot(snapshot, conversationIds);
      }
    case "drainChatMessages":
      if (chatSyncError !== undefined) {
        const error = chatSyncError;
        chatSyncError = undefined;
        throw error;
      }
      return chatMessages.splice(0);
    case "drainSnapMessages":
      if (officialRuntime === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Content runtime is not initialized");
      }
      return incomingSnapQueue.drain((candidate) => resolveIncomingSnap(officialRuntime!, candidate));
    case "shutdown":
      await officialRuntime?.shutdown();
      installedGlobals?.restore();
      installedGlobals = undefined;
      adapter = undefined;
      officialRuntime = undefined;
      messagingInitialization.reset();
      photoBuilder = undefined;
      photoRequestAuth = undefined;
      photoUploadError = undefined;
      chatSyncError = undefined;
      incomingSnapQueue.setActive(false);
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
