import type { IndexedDbSnapshot } from "../session/types.js";

export interface RuntimeStatus {
  readonly buildId: "8dd50222";
  readonly initializedAt: string;
}

export interface ChatInput {
  readonly recipientId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly text: string;
}

export interface EncryptedContent {
  readonly bytes: Uint8Array;
  readonly contentType: "chat" | "photo-snap";
  readonly createContentMessagePayload?: Uint8Array;
}

export interface ChatMessage {
  readonly senderId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: string;
}

export interface PhotoSnapInput {
  readonly recipientId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly contentReference: Uint8Array;
}

export interface ExportedRootWrappingKey {
  readonly data: string;
  readonly identityKeyId: string;
}

export interface CryptoStateExport {
  readonly localStorage: Readonly<Record<string, string>>;
  readonly indexedDb: IndexedDbSnapshot;
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly rootWrappingKey?: ExportedRootWrappingKey;
}

export interface AuthRefreshResult {
  readonly httpToken: string;
  readonly gatewayToken: string;
  readonly refreshedAt: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
}
