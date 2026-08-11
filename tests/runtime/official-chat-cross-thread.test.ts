import { describe, expect, it } from "vitest";
import { captureOfficialChatEnvelope } from "../../src/runtime/official-chat-capture.js";
import { OfficialWorkerClient } from "../../src/runtime/official-worker-client.js";

describe("official Chat capture across Worker proxies", () => {
  it("passes destination, content, and callbacks across the Comlink contract", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-chat-capture-worker.mjs", import.meta.url),
    });
    try {
      const session = await client.createMessagingSession([]);
      const manager = await session.callRemote(["getConversationManager"]);
      await expect(captureOfficialChatEnvelope(client, manager, {
        recipientId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        clientMessageId: "44444444-4444-4444-8444-444444444444",
        text: "hello",
      })).resolves.toEqual({
        bytes: new Uint8Array([9, 8, 7]),
        contentType: "chat",
        createContentMessagePayload: new Uint8Array([0x22, 0x03, 9, 8, 7]),
      });
    } finally {
      await client.shutdown();
    }
  });
});
