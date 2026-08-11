import type { ChatMessage } from "./content-types.js";

type DecodeMessageContent = (content: unknown) => unknown;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const candidate = record(value);
  if (typeof candidate?.str === "string" && candidate.str.length > 0) return candidate.str;
  if (!(candidate?.id instanceof Uint8Array) || candidate.id.length !== 16) return undefined;
  const hex = [...candidate.id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeOfficialChatMessages(
  messages: readonly unknown[],
  decode: DecodeMessageContent,
  receivedAt = new Date().toISOString(),
): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const value of messages) {
    try {
      const message = record(value);
      const descriptor = record(message?.descriptor);
      const senderId = identifier(message?.senderId);
      const conversationId = identifier(descriptor?.conversationId);
      const messageId = identifier(descriptor?.messageId);
      if (
        senderId === undefined ||
        conversationId === undefined ||
        messageId === undefined ||
        message?.messageContent === undefined
      ) continue;
      const decoded = record(decode(message.messageContent));
      const content = record(decoded?.content);
      const textContent = record(content?.text);
      const text = textContent?.text;
      if (content?.$case !== "text" || typeof text !== "string" || text.length === 0) continue;
      normalized.push({ senderId, conversationId, messageId, text, timestamp: receivedAt });
    } catch {
      // Unknown protected content stays inside the runtime boundary.
    }
  }
  return normalized;
}
