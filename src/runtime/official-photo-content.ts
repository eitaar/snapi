import { AppError } from "../errors.js";
import { captureWebpackModules } from "../compat/module-scanner.js";
import { createWebpackRuntime, rebindWebpackFactories, type WebpackRuntime } from "./webpack-runtime.js";
import { normalizeOfficialChatMessages } from "./official-chat-message.js";
import type { ChatMessage } from "./content-types.js";
import type { ChatInput } from "./content-types.js";

export interface OfficialPhotoBuildInput {
  readonly recipientId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export interface OfficialPhotoDestination {
  readonly phoneNumbers: readonly unknown[];
  readonly conversations: readonly { readonly id: Uint8Array; readonly str: string }[];
  readonly stories: readonly unknown[];
  readonly massSnaps: readonly unknown[];
}

export interface OfficialPhotoMessageContent {
  readonly content: Uint8Array;
  readonly contentType: number;
  readonly localMediaReferences: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface PreparedOfficialPhotoContent {
  readonly destination: OfficialPhotoDestination;
  readonly content: OfficialPhotoMessageContent;
}

export interface PreparedOfficialChatContent {
  readonly destination: OfficialPhotoDestination;
  readonly content: OfficialPhotoMessageContent;
}

export interface OfficialLocalMedia {
  readonly data: Blob;
  readonly type: "Image";
  readonly hasAudio: false;
}

export interface OfficialMediaCrypto {
  readonly encryptedData: Uint8Array;
  readonly cryptoKeyIvPair: {
    readonly key: CryptoKey;
    readonly iv: Uint8Array;
  };
}

export interface FinalizedOfficialUpload {
  readonly content: OfficialPhotoMessageContent;
  readonly remoteMediaReferences: unknown;
}

export interface OfficialUploadResult {
  readonly status: number;
  readonly timers: ReadonlyMap<unknown, bigint>;
  readonly mediaOrchestrationAttemptId: { readonly id: Uint8Array };
  readonly remoteMediaReferences?: unknown;
  readonly failedStep?: number;
}

function uuidValue(value: string, field: string): { readonly id: Uint8Array; readonly str: string } {
  const normalized = value.toLowerCase();
  const hex = normalized.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new AppError("INVALID_CONFIG", `${field} must be a UUID`, { field });
  }
  return {
    id: Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))),
    str: normalized,
  };
}

export class OfficialPhotoContentBuilder {
  private readonly runtime: WebpackRuntime;
  private currentInput: OfficialPhotoBuildInput | undefined;
  private currentClientMessageId: string | undefined;

  constructor(mainAssetSource: string) {
    const factories = rebindWebpackFactories(captureWebpackModules(mainAssetSource));
    const base = createWebpackRuntime(factories);
    const mediaHelpers = base.require("73796") as Record<string, unknown>;
    const stubs = new Map<string, unknown>([
      ["2092", { Ju: (value: unknown) => {
        const destination = value as Partial<OfficialPhotoDestination>;
        return {
          phoneNumbers: destination.phoneNumbers ?? [],
          conversations: destination.conversations ?? [],
          stories: destination.stories ?? [],
          massSnaps: destination.massSnaps ?? [],
        };
      } }],
      ["94994", { v: Error }],
      ["77499", { xX: { OS_WEB: 0 } }],
      ["41359", { hm: () => 0 }],
      ["48688", { s: { getState: () => ({}) } }],
      ["22751", { ig: () => ({ getClientCofValue: async () => ({ value: false }) }) }],
      ["6781", { Z: { getState: () => ({}) } }],
      ["99244", { OS: async () => [] }],
      ["83445", { L7: Promise.resolve(undefined) }],
      ["42472", { Cd: (value: unknown) => value }],
      ["37390", { ok: Error }],
      ["4401", { fC: async () => [] }],
      ["62347", { BX: (value: unknown) => value }],
      ["18562", { A: () => this.requireClientMessageId() }],
      ["73796", {
        ...mediaHelpers,
        pg: async () => {
          const input = this.requireInput();
          return {
            width: input.width,
            height: input.height,
            mediaType: "Image",
            hasAudio: false,
            zipped: false,
          };
        },
      }],
    ]);
    this.runtime = createWebpackRuntime(factories, stubs);
  }

  private requireInput(): OfficialPhotoBuildInput {
    if (this.currentInput === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official photo builder has no active input");
    }
    return this.currentInput;
  }

  private requireClientMessageId(): string {
    if (this.currentClientMessageId === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official content builder has no active message");
    }
    return this.currentClientMessageId;
  }

  async prepare(input: OfficialPhotoBuildInput): Promise<PreparedOfficialPhotoContent> {
    if (this.currentInput !== undefined) {
      throw new AppError("CRYPTO_STATE_CONFLICT", "Official photo builder is already active");
    }
    this.currentInput = input;
    this.currentClientMessageId = input.clientMessageId;
    try {
      const destination: OfficialPhotoDestination = {
        phoneNumbers: [],
        conversations: [uuidValue(input.conversationId, "conversationId")],
        stories: [],
        massSnaps: [],
      };
      let captured: OfficialPhotoMessageContent | undefined;
      const session = {
        getConversationManager: () => ({
          sendMessageWithContent: (
            _destination: OfficialPhotoDestination,
            content: OfficialPhotoMessageContent,
            callback: { readonly onQueued?: () => void; readonly onSuccess?: () => void },
          ) => {
            captured = content;
            callback.onQueued?.();
            callback.onSuccess?.();
          },
        }),
      };
      const api = this.runtime.require("56639") as {
        readonly HM: (
          session: unknown,
          destination: OfficialPhotoDestination,
          snap: unknown,
        ) => Promise<void>;
      };
      await api.HM(session, destination, {
        media: new Blob([Uint8Array.from(input.bytes)], { type: input.mimeType }),
        mediaType: "Image",
        hasAudio: false,
      });
      if (captured === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Official photo module did not create message content");
      }
      return { destination, content: captured };
    } finally {
      this.currentInput = undefined;
      this.currentClientMessageId = undefined;
    }
  }

  async prepareChat(input: ChatInput): Promise<PreparedOfficialChatContent> {
    if (this.currentClientMessageId !== undefined) {
      throw new AppError("CRYPTO_STATE_CONFLICT", "Official content builder is already active");
    }
    this.currentClientMessageId = input.clientMessageId;
    try {
      const conversation = uuidValue(input.conversationId, "conversationId");
      let captured: OfficialPhotoMessageContent | undefined;
      const session = {
        getConversationManager: () => ({
          sendMessageWithContent: (
            destination: OfficialPhotoDestination,
            content: OfficialPhotoMessageContent,
            callback: { readonly onQueued?: () => void; readonly onSuccess?: () => void },
          ) => {
            captured = content;
            callback.onQueued?.();
            callback.onSuccess?.();
            return destination;
          },
        }),
      };
      const api = this.runtime.require("56639") as {
        readonly pn: (
          session: unknown,
          conversation: OfficialPhotoDestination["conversations"][number],
          text: string,
          quotedMessageId?: unknown,
          analyticsContent?: unknown,
          save?: boolean,
        ) => Promise<unknown>;
      };
      await api.pn(session, conversation, input.text, undefined, undefined, false);
      if (captured === undefined) {
        throw new AppError("CRYPTO_RUNTIME_FAILED", "Official Chat module did not create message content");
      }
      return {
        destination: { phoneNumbers: [], conversations: [conversation], stories: [], massSnaps: [] },
        content: captured,
      };
    } finally {
      this.currentClientMessageId = undefined;
    }
  }

  decodeChatMessages(messages: readonly unknown[], receivedAt?: string): ChatMessage[] {
    const messageHelpers = this.runtime.require("60412") as {
      readonly wn: (content: unknown) => unknown;
    };
    return normalizeOfficialChatMessages(
      messages,
      (content) => messageHelpers.wn(content),
      receivedAt,
    );
  }

  isUnauthorizedCallbackStatus(value: unknown): boolean {
    const enums = this.runtime.require("20606") as {
      readonly o3: { readonly UNAUTHORIZED: number };
    };
    return value === enums.o3.UNAUTHORIZED;
  }

  resolveMedia(reference: unknown): OfficialLocalMedia | undefined {
    const registry = this.runtime.require("28142") as {
      readonly sW: (reference: unknown) => OfficialLocalMedia | undefined;
    };
    return registry.sW(reference);
  }

  async encryptMedia(reference: unknown): Promise<OfficialMediaCrypto> {
    const media = this.resolveMedia(reference);
    if (media === undefined) {
      throw new AppError("UPLOAD_FAILED", "Official local media reference could not be resolved");
    }
    const cryptoModule = this.runtime.require("60446") as {
      readonly Gr: (data: Blob) => Promise<{
        readonly encryptedData: ArrayBuffer;
        readonly cryptoKeyIvPair: { readonly key: CryptoKey; readonly iv: Uint8Array };
      }>;
    };
    const encrypted = await cryptoModule.Gr(media.data);
    return {
      encryptedData: new Uint8Array(encrypted.encryptedData),
      cryptoKeyIvPair: encrypted.cryptoKeyIvPair,
    };
  }

  async finalizeUpload(
    content: OfficialPhotoMessageContent,
    index: number,
    reference: unknown,
    contentObject: Uint8Array,
    cryptoKeyIvPair: OfficialMediaCrypto["cryptoKeyIvPair"],
  ): Promise<FinalizedOfficialUpload> {
    const media = this.resolveMedia(reference);
    if (media === undefined) {
      throw new AppError("UPLOAD_FAILED", "Official local media reference could not be resolved");
    }
    const messageHelpers = this.runtime.require("60412") as {
      readonly wn: (content: OfficialPhotoMessageContent) => unknown;
    };
    const decoded = messageHelpers.wn(content) as {
      readonly content?: {
        readonly $case?: string;
        readonly snapdoc?: {
          readonly playback?: {
            readonly playbackLayers?: Array<{
              readonly layer?: {
                readonly $case?: string;
                readonly media?: Record<string, unknown>;
              };
            }>;
          };
        };
      };
    } | undefined;
    if (decoded?.content?.$case !== "snapdoc" || decoded.content.snapdoc === undefined) {
      throw new AppError("UPLOAD_FAILED", "Official photo content is not a SnapDoc");
    }
    const mediaHelpers = this.runtime.require("73796") as {
      readonly I4: (type: string, hasAudio: boolean) => number;
      readonly pi: (type: string) => number;
    };
    const cryptoModule = this.runtime.require("60446") as {
      readonly KA: (bytes: Uint8Array) => Uint8Array;
    };
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoKeyIvPair.key));
    for (const layer of decoded.content.snapdoc.playback?.playbackLayers ?? []) {
      if (layer.layer?.$case !== "media" || layer.layer.media === undefined) continue;
      const layerMedia = layer.layer.media;
      layerMedia.type = mediaHelpers.pi(media.type);
      layerMedia.mediaId = { mediaListId: String(index) };
      layerMedia.encryptionInfoV1 = {
        key: cryptoModule.KA(rawKey),
        iv: cryptoModule.KA(cryptoKeyIvPair.iv),
      };
      layerMedia.encryptionInfoV2 = { key: rawKey, iv: cryptoKeyIvPair.iv };
      layerMedia.zipped = false;
    }
    const contentCodec = this.runtime.require("79752") as {
      readonly v: { readonly encode: (value: unknown) => { readonly finish: () => Uint8Array } };
    };
    const remoteMediaReferences = {
      mediaReferences: [{
        contentObject,
        mediaListId: BigInt(index),
        mediaType: mediaHelpers.I4(media.type, media.hasAudio),
        mediaReferenceKey: "",
      }],
    };
    return {
      content: { ...content, content: contentCodec.v.encode(decoded).finish() },
      remoteMediaReferences,
    };
  }

  uploadResult(remoteMediaReferences: unknown, success: boolean): OfficialUploadResult {
    const enums = this.runtime.require("20606") as {
      readonly RG: { readonly SUCCESS: number; readonly FATAL_ERROR: number };
      readonly y1: { readonly RESOLVE: number };
    };
    if (!success) {
      return {
        status: enums.RG.FATAL_ERROR,
        failedStep: enums.y1.RESOLVE,
        timers: new Map(),
        mediaOrchestrationAttemptId: { id: new Uint8Array(16) },
      };
    }
    return {
      status: enums.RG.SUCCESS,
      timers: new Map(),
      mediaOrchestrationAttemptId: { id: new Uint8Array(16) },
      remoteMediaReferences,
    };
  }
}
