import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { ChatMessage, CryptoStateExport, EncryptedContent } from "../runtime/content-types.js";
import type { UnaryCallOptions, UnaryResult } from "../transport/grpc-client.js";

export const MAX_CHAT_UTF8_BYTES = 16_384;

export interface SendTextInput {
  readonly recipientId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly clientMessageId?: string;
}

export interface SendResult {
  readonly clientMessageId: string;
  readonly serverMessageId?: string;
  readonly status: "confirmed" | "unconfirmed";
}

export interface ChatMessageEvent extends ChatMessage {
  readonly type: "chat.message";
}

interface MessagingRuntime {
  encryptChat(input: {
    readonly recipientId: string;
    readonly conversationId: string;
    readonly clientMessageId: string;
    readonly text: string;
  }): Promise<EncryptedContent>;
  exportState(): Promise<CryptoStateExport>;
  syncMessages(): Promise<void>;
  drainChatMessages(): Promise<readonly ChatMessage[]>;
}

interface MessagingGrpc {
  unary(
    service: string,
    method: string,
    payload: Uint8Array,
    options: UnaryCallOptions,
  ): Promise<UnaryResult>;
}

interface CryptoStateStore {
  write(value: CryptoStateExport): Promise<void>;
}

export interface MessagingClientDependencies {
  readonly runtime: MessagingRuntime;
  readonly grpc: MessagingGrpc;
  readonly stateStore: CryptoStateStore;
  readonly sendTyping?: (conversationId: string) => Promise<void>;
  readonly randomUuid?: () => string;
  readonly pollDelayMs?: number;
}

export class MessagingClient {
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly dependencies: MessagingClientDependencies) {}

  async sendText(input: SendTextInput): Promise<SendResult> {
    const textBytes = new TextEncoder().encode(input.text).length;
    if (textBytes === 0) {
      throw new AppError("INVALID_CONFIG", "Chat text must not be empty");
    }
    if (textBytes > MAX_CHAT_UTF8_BYTES) {
      throw new AppError("INVALID_CONFIG", "Chat text exceeds the UTF-8 byte limit", {
        maxBytes: MAX_CHAT_UTF8_BYTES,
        actualBytes: textBytes,
      });
    }

    const clientMessageId = input.clientMessageId ??
      (this.dependencies.randomUuid ?? randomUUID)();
    await this.dependencies.sendTyping?.(input.conversationId);
    const encrypted = await this.dependencies.runtime.encryptChat({
      recipientId: input.recipientId,
      conversationId: input.conversationId,
      clientMessageId,
      text: input.text,
    });
    if (encrypted.createContentMessagePayload === undefined) {
      throw new AppError(
        "UNSUPPORTED_BUILD",
        "Official runtime did not provide a CreateContentMessage payload",
      );
    }

    try {
      await this.dependencies.grpc.unary(
        "messagingcoreservice.MessagingCoreService",
        "CreateContentMessage",
        encrypted.createContentMessagePayload,
        {
          timeoutMs: 30_000,
          retryKind: "message-with-client-id",
          replayPolicy: "ambiguous-send",
        },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "NETWORK_FAILED") {
        throw new AppError(
          "DELIVERY_UNCONFIRMED",
          "Chat delivery could not be confirmed and was not retried",
          { clientMessageId },
        );
      }
      throw error;
    }

    const state = await this.dependencies.runtime.exportState();
    await this.dependencies.stateStore.write(state);
    return { clientMessageId, status: "confirmed" };
  }

  messages(signal?: AbortSignal): AsyncIterableIterator<ChatMessageEvent> {
    const dependencies = this.dependencies;
    const seen = this.seenMessageIds;
    const delayMs = dependencies.pollDelayMs ?? 250;
    return (async function* (): AsyncGenerator<ChatMessageEvent> {
      if (signal?.aborted) return;
      await dependencies.runtime.syncMessages();
      while (!signal?.aborted) {
        const messages = await dependencies.runtime.drainChatMessages();
        if (messages.length === 0) {
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            timer = setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            }, delayMs);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
          continue;
        }
        for (const message of messages) {
          if (signal?.aborted) return;
          if (seen.has(message.messageId)) continue;
          const state = await dependencies.runtime.exportState();
          await dependencies.stateStore.write(state);
          seen.add(message.messageId);
          yield { type: "chat.message", ...message };
        }
      }
    })();
  }
}
