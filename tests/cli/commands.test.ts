import { describe, expect, it, vi } from "vitest";
import { main, type ConfiguredCliClient } from "../../src/cli/index.js";
import { AppError } from "../../src/errors.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      version: "0.1.0",
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

function configured(overrides: Partial<ConfiguredCliClient["client"]> = {}): ConfiguredCliClient {
  return {
    output: "json",
    client: {
      sendText: vi.fn(async () => ({ clientMessageId: "message-id", status: "confirmed" as const })),
      sendPhotoSnap: vi.fn(async () => ({ clientMessageId: "photo-id", status: "confirmed" as const })),
      watchEvents: vi.fn(async (): Promise<AsyncIterableIterator<unknown>> => {
        const iterator: AsyncIterableIterator<unknown> = {
          async next() { return { value: undefined, done: true }; },
          [Symbol.asyncIterator]() { return this; },
        };
        return iterator;
      }),
      status: vi.fn(() => "open" as const),
      watchMessages: vi.fn(() => (async function* () {
        yield {
          type: "chat.message" as const,
          senderId: "sender",
          conversationId: "conversation",
          messageId: "received-message",
          text: "intended plaintext",
          timestamp: "2026-08-11T00:00:00.000Z",
        };
      })()),
      close: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

describe("CLI commands", () => {
  it("routes chat send with an explicit conversation and does not echo plaintext", async () => {
    const output = io();
    const state = configured();
    const createClient = vi.fn(async () => state);
    const code = await main([
      "chat", "send", "recipient-id", "private message", "--conversation-id", "conversation-id",
    ], output.value, { createClient });

    expect(code).toBe(0);
    expect(state.client.sendText).toHaveBeenCalledWith({
      recipientId: "recipient-id",
      conversationId: "conversation-id",
      text: "private message",
    });
    expect(output.stdout.join("\n")).not.toContain("private message");
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ type: "chat.sent", status: "confirmed" });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("returns usage code without creating a client when conversation-id is missing", async () => {
    const output = io();
    const createClient = vi.fn();
    await expect(main(["chat", "send", "recipient", "text"], output.value, { createClient }))
      .resolves.toBe(2);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps ambiguous delivery to exit 5 and redacts error details", async () => {
    const output = io();
    const state = configured({
      sendText: async () => {
        throw new AppError("DELIVERY_UNCONFIRMED", "Delivery was not confirmed", {
          authorizationToken: "secret-sentinel",
        });
      },
    });
    const code = await main([
      "chat", "send", "recipient", "text", "--conversation-id", "conversation",
    ], output.value, { createClient: async () => state });
    expect(code).toBe(5);
    expect(output.stderr.join("\n")).toContain("DELIVERY_UNCONFIRMED");
    expect(output.stderr.join("\n")).not.toContain("secret-sentinel");
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("routes native photo Snap send without echoing image bytes", async () => {
    const output = io();
    const state = configured();
    const bytes = new Uint8Array([1, 2, 3]);
    const code = await main([
      "snap", "send", "recipient", "photo.png", "--conversation-id", "conversation",
    ], output.value, {
      createClient: async () => state,
      readFile: async () => bytes,
    });
    expect(code).toBe(0);
    expect(state.client.sendPhotoSnap).toHaveBeenCalledWith({
      recipientId: "recipient",
      conversationId: "conversation",
      filename: "photo.png",
      bytes,
    });
    expect(output.stdout.join("\n")).not.toContain("1,2,3");
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("connects the Gateway and prints its live status", async () => {
    const output = io();
    const state = configured();
    const code = await main(["gateway", "status"], output.value, {
      createClient: async () => state,
    });
    expect(code).toBe(0);
    expect(state.client.watchEvents).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout[0]!)).toEqual({ type: "gateway.status", status: "open" });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("prints intended incoming plaintext only for chat watch", async () => {
    const output = io();
    const state = configured();
    const code = await main(["chat", "watch", "--json"], output.value, {
      createClient: async () => state,
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "chat.message",
      senderId: "sender",
      conversationId: "conversation",
      messageId: "received-message",
      text: "intended plaintext",
      timestamp: "2026-08-11T00:00:00.000Z",
    });
    expect(state.client.close).toHaveBeenCalledOnce();
  });
});
