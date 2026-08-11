import { describe, expect, it } from "vitest";
import { normalizeOfficialChatMessages } from "../../src/runtime/official-chat-message.js";

describe("official Chat message normalization", () => {
  it("uses the official decoder and emits only text messages", () => {
    const decode = (content: unknown) => content === "encoded-text"
      ? { content: { $case: "text", text: { text: "hello" } } }
      : { content: { $case: "snapdoc", snapdoc: {} } };
    const messages = [{
      descriptor: {
        messageId: { str: "message-id" },
        conversationId: { str: "conversation-id" },
      },
      senderId: { str: "sender-id" },
      messageContent: "encoded-text",
    }, {
      descriptor: { messageId: "snap-id", conversationId: "conversation-id" },
      senderId: "sender-id",
      messageContent: "encoded-snap",
    }];

    expect(normalizeOfficialChatMessages(messages, decode, "2026-08-11T00:00:00.000Z"))
      .toEqual([{
        senderId: "sender-id",
        conversationId: "conversation-id",
        messageId: "message-id",
        text: "hello",
        timestamp: "2026-08-11T00:00:00.000Z",
      }]);
  });

  it("ignores malformed callback values instead of exposing protected payloads", () => {
    expect(normalizeOfficialChatMessages([
      null,
      { descriptor: {}, senderId: "sender", messageContent: {} },
    ], () => { throw new Error("decode failed"); }, "now")).toEqual([]);
  });
});
