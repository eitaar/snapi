import { describe, expect, it, vi } from "vitest";
import { captureOfficialChatEnvelope } from "../../src/runtime/official-chat-capture.js";
import type { OfficialRemote, OfficialWorkerClient } from "../../src/runtime/official-worker-client.js";
import { encodeDataFrame } from "../../src/wire/grpc-web.js";
import { writeBytesField } from "../../src/wire/protobuf.js";

const input = {
  recipientId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  clientMessageId: "44444444-4444-4444-8444-444444444444",
  text: "hello",
};

describe("official Chat capture flow", () => {
  it("enables capture before invoking the manager and returns the captured envelope", async () => {
    const envelope = new Uint8Array([7, 8, 9]);
    const captured = [{
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
      method: "POST",
      body: encodeDataFrame(writeBytesField(4, envelope)),
    }];
    let drains = 0;
    const apply = vi.fn(async (path: readonly string[]) => {
      if (path[1] === "beginCaptureOnly") return true;
      drains += 1;
      return drains === 1 ? [] : captured;
    });
    const managerCall = vi.fn(async (
      _path: readonly string[],
      _args: readonly unknown[] = [],
    ) => undefined);
    const runtime = { apply } as unknown as OfficialWorkerClient;
    const manager = { call: managerCall } as unknown as OfficialRemote;

    await expect(captureOfficialChatEnvelope(runtime, manager, input, {
      timeoutMs: 100,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      bytes: envelope,
      contentType: "chat",
      createContentMessagePayload: writeBytesField(4, envelope),
    });

    expect(apply.mock.calls[0]).toEqual([["__host", "beginCaptureOnly"]]);
    expect(managerCall).toHaveBeenCalledOnce();
    const args = managerCall.mock.calls[0]?.[1] ?? [];
    expect(args[0]).toMatchObject({ conversations: [{ str: input.conversationId }] });
    expect(args[1]).toMatchObject({ contentType: 2, savePolicy: 1 });
  });

  it("times out safely when no CreateContentMessage request is produced", async () => {
    let time = 0;
    const runtime = {
      apply: async (path: readonly string[]) => path[1] === "beginCaptureOnly" ? true : [],
    } as unknown as OfficialWorkerClient;
    const manager = { call: async () => undefined } as unknown as OfficialRemote;

    await expect(captureOfficialChatEnvelope(runtime, manager, input, {
      timeoutMs: 2,
      now: () => time++,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
  });
});
