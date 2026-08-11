import { describe, expect, it, vi } from "vitest";
import { SnapchatClient, type SnapchatClientComponents } from "../src/client.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  sessionFile: "session.json",
  assetDir: "assets",
  accountId: "account",
  buildId: "8dd50222",
  output: "json",
};

function components(events: string[]): SnapchatClientComponents {
  return {
    messaging: {
      sendText: vi.fn(async () => ({ clientMessageId: "message-id", status: "confirmed" as const })),
      messages: vi.fn(() => (async function* () {
        yield {
          type: "chat.message" as const,
          senderId: "sender",
          conversationId: "conversation",
          messageId: "message",
          text: "hello",
          timestamp: "now",
        };
      })()),
    },
    media: {
      sendPhotoSnap: vi.fn(async () => ({ clientMessageId: "photo-id", status: "confirmed" as const })),
    },
    gateway: {
      connect: vi.fn(async () => undefined),
      events: vi.fn(() => ({
        async next() { return { value: undefined, done: true } as IteratorResult<never>; },
        [Symbol.asyncIterator]() { return this; },
      })),
      status: vi.fn(() => "idle" as const),
      close: vi.fn(async () => { events.push("gateway.close"); }),
    },
    runtime: { shutdown: vi.fn(async () => { events.push("runtime.shutdown"); }) },
    lock: { path: "lock", release: vi.fn(async () => { events.push("lock.release"); }), [Symbol.asyncDispose]: async () => undefined },
  };
}

describe("SnapchatClient", () => {
  it("delegates Chat send and closes resources in dependency order", async () => {
    const events: string[] = [];
    const state = components(events);
    const client = await SnapchatClient.create(config, { compose: async () => state });
    await expect(client.sendText({ recipientId: "recipient", conversationId: "conversation", text: "hello" }))
      .resolves.toMatchObject({ status: "confirmed" });
    expect(state.messaging.sendText).toHaveBeenCalledOnce();
    await client.close();
    expect(events).toEqual(["gateway.close", "runtime.shutdown", "lock.release"]);
  });

  it("is idempotent on close", async () => {
    const events: string[] = [];
    const client = await SnapchatClient.create(config, { compose: async () => components(events) });
    await client.close();
    await client.close();
    expect(events).toEqual(["gateway.close", "runtime.shutdown", "lock.release"]);
  });

  it("connects event watching, exposes status, and delegates photo sends", async () => {
    const events: string[] = [];
    const state = components(events);
    const client = await SnapchatClient.create(config, { compose: async () => state });
    expect(client.status()).toBe("idle");
    await expect(client.watchEvents()).resolves.toEqual(expect.objectContaining({ next: expect.any(Function) }));
    expect(state.gateway.connect).toHaveBeenCalledOnce();
    await expect(client.sendPhotoSnap({
      recipientId: "recipient",
      conversationId: "conversation",
      filename: "photo.png",
      bytes: new Uint8Array([1]),
    })).resolves.toMatchObject({ clientMessageId: "photo-id" });
    expect(state.media.sendPhotoSnap).toHaveBeenCalledOnce();
    await client.close();
  });

  it("rejects operations after close", async () => {
    const client = await SnapchatClient.create(config, { compose: async () => components([]) });
    await client.close();
    await expect(client.sendText({ recipientId: "r", conversationId: "c", text: "t" }))
      .rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
    await expect(client.sendPhotoSnap({ recipientId: "r", conversationId: "c", filename: "x.png", bytes: new Uint8Array() }))
      .rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
    await expect(client.watchEvents()).rejects.toMatchObject({ code: "GATEWAY_DISCONNECTED" });
  });

  it("still shuts down runtime and releases the lock when gateway close fails", async () => {
    const events: string[] = [];
    const state = components(events);
    state.gateway.close = vi.fn(async () => { events.push("gateway.close"); throw new Error("close failed"); });
    const client = await SnapchatClient.create(config, { compose: async () => state });
    await expect(client.close()).rejects.toThrow("close failed");
    expect(events).toEqual(["gateway.close", "runtime.shutdown", "lock.release"]);
  });
});
