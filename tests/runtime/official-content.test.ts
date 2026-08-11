import { describe, expect, it } from "vitest";
import {
  createOfficialChatArguments,
  encodeOfficialChatContents,
} from "../../src/runtime/official-content.js";

describe("official Chat input", () => {
  it("encodes the observed Contents.text protobuf shape", () => {
    expect(encodeOfficialChatContents("hi")).toEqual(new Uint8Array([
      0x12, 0x04,
      0x0a, 0x02, 0x68, 0x69,
    ]));
  });

  it("builds the observed destination and content metadata", () => {
    const [destination, content] = createOfficialChatArguments({
      recipientId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      text: "hello",
    });

    expect(destination).toEqual({
      phoneNumbers: [],
      conversations: [{
        id: new Uint8Array([
          0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x43, 0x33,
          0x83, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
        ]),
        str: "33333333-3333-4333-8333-333333333333",
      }],
      stories: [],
      massSnaps: [],
    });
    expect(content).toMatchObject({
      contentType: 2,
      localMediaReferences: [],
      incidentalAttachments: [],
      savePolicy: 1,
      allowsTranscription: false,
      botMention: false,
      platformAnalytics: {
        metricsMessageType: 0,
        metricsMessageMediaType: 0,
        reactionSource: 0,
        attemptId: {
          str: "44444444-4444-4444-8444-444444444444",
        },
      },
    });
    expect(content.content).toEqual(encodeOfficialChatContents("hello"));
  });

  it("rejects malformed conversation and message UUIDs", () => {
    expect(() => createOfficialChatArguments({
      recipientId: "recipient",
      conversationId: "not-a-uuid",
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      text: "hello",
    })).toThrow("must be a UUID");
    expect(() => createOfficialChatArguments({
      recipientId: "recipient",
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "not-a-uuid",
      text: "hello",
    })).toThrow("must be a UUID");
  });
});
