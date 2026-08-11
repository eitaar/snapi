import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { SendResult } from "../messaging/client.js";
import type { CryptoStateExport, EncryptedContent, PhotoSnapInput } from "../runtime/content-types.js";
import type { UnaryCallOptions, UnaryResult } from "../transport/grpc-client.js";
import { validatePhoto } from "./image.js";

export interface SendPhotoSnapInput {
  readonly recipientId: string;
  readonly conversationId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly clientMessageId?: string;
}

interface PhotoRuntime {
  createPhotoSnap(input: PhotoSnapInput): Promise<EncryptedContent>;
  exportState(): Promise<CryptoStateExport>;
}

interface PhotoGrpc {
  unary(
    service: string,
    method: string,
    payload: Uint8Array,
    options: UnaryCallOptions,
  ): Promise<UnaryResult>;
}

interface PhotoStateStore {
  write(value: CryptoStateExport): Promise<void>;
}

export interface MediaClientDependencies {
  readonly runtime: PhotoRuntime;
  readonly grpc: PhotoGrpc;
  readonly stateStore: PhotoStateStore;
  readonly randomUuid?: () => string;
}

export class MediaClient {
  constructor(private readonly dependencies: MediaClientDependencies) {}

  async sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult> {
    const photo = validatePhoto(input.bytes, input.filename);
    const clientMessageId = input.clientMessageId ??
      (this.dependencies.randomUuid ?? randomUUID)();
    const encrypted = await this.dependencies.runtime.createPhotoSnap({
      recipientId: input.recipientId,
      conversationId: input.conversationId,
      clientMessageId,
      mimeType: photo.mimeType,
      width: photo.width,
      height: photo.height,
      bytes: photo.bytes,
    });
    if (encrypted.createContentMessagePayload === undefined) {
      throw new AppError(
        "UNSUPPORTED_BUILD",
        "Official runtime did not provide a photo CreateContentMessage payload",
      );
    }
    try {
      await this.dependencies.grpc.unary(
        "messagingcoreservice.MessagingCoreService",
        "CreateContentMessage",
        encrypted.createContentMessagePayload,
        { timeoutMs: 30_000, retryKind: "message-with-client-id" },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "NETWORK_FAILED") {
        throw new AppError(
          "DELIVERY_UNCONFIRMED",
          "Photo Snap delivery could not be confirmed and was not retried",
          { clientMessageId },
        );
      }
      throw error;
    }
    const state = await this.dependencies.runtime.exportState();
    await this.dependencies.stateStore.write(state);
    return { clientMessageId, status: "confirmed" };
  }
}
