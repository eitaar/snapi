import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      watchSnaps: vi.fn(() => (async function* () {
        yield {
          type: "snap.received" as const,
          senderId: "sender",
          conversationId: "conversation",
          messageId: "received-snap",
          timestamp: "2026-08-11T00:00:00.000Z",
          media: [{
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "image/jpeg",
            hasAudio: false,
        }],
        };
      })()),
      listFriends: vi.fn(async () => ({
        syncedAt: "2026-08-12T00:00:00.000Z",
        status: "success" as const,
        friends: [],
        incomingRequests: [],
      })),
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

  it("routes read-only friend listing", async () => {
    const output = io();
    const state = configured();
    const code = await main(["friends", "list"], output.value, {
      createClient: async () => state,
    });

    expect(code).toBe(0);
    expect(state.client.listFriends).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ type: "friends.list", status: "success" });
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

  it("saves incoming Snap media without printing its bytes", async () => {
    const output = io();
    const state = configured();
    const outputDir = await mkdtemp(join(tmpdir(), "snap-cli-"));
    try {
      const code = await main(["snap", "watch", "--output-dir", outputDir, "--json"], output.value, {
        createClient: async () => state,
      });
      expect(code).toBe(0);
      expect(state.client.watchSnaps).toHaveBeenCalledOnce();
      expect(output.stdout.join("\n")).not.toContain("1,2,3");
      expect(JSON.parse(output.stdout[0]!)).toMatchObject({
        type: "snap.received",
        files: [expect.stringContaining("received-snap-0.jpg")],
      });
      expect(state.client.close).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("blocks auth-gap live probing unless explicitly enabled", async () => {
    const output = io();
    const readFile = vi.fn(async () => new Uint8Array());
    const code = await main([
      "debug", "auth-gap",
      "--request", "private/request.json",
      "--session", "private/session.json",
      "--mode", "node-bearer",
      "--auth-epoch", "edge-capture-1",
    ], output.value, { readFile, env: {} });

    expect(code).toBe(3);
    expect(output.stderr.join("\n")).toContain("INVALID_CONFIG");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("routes a safe auth-gap result without echoing credentials", async () => {
    const output = io();
    const request = {
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      headers: {
        accept: "application/grpc-web+proto",
        authorization: "request-token-must-not-echo",
      },
      bodyBase64: Buffer.from([1, 2, 3]).toString("base64"),
    };
    const session = {
      formatVersion: 1,
      accountId: "account-1",
      buildId: "8dd50222",
      exportedAt: "2026-08-11T00:00:00.000Z",
      auth: {
        httpToken: "session-token-must-not-echo",
        gatewayToken: "gateway-token-must-not-echo",
        cookieHeader: "web-cookie-must-not-echo",
        requestHeaders: {},
      },
      assets: [],
      localStorage: {},
      indexedDb: { databases: [] },
    };
    const encoded = new Map([
      ["private/request.json", new TextEncoder().encode(JSON.stringify(request))],
      ["private/session.json", new TextEncoder().encode(JSON.stringify(session))],
    ]);
    const readFile = vi.fn(async (path: string) => encoded.get(path)!);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer session-token-must-not-echo");
      return new Response(null, { status: 401 });
    });

    const code = await main([
      "debug", "auth-gap",
      "--request", "private/request.json",
      "--session", "private/session.json",
      "--mode", "node-bearer",
      "--auth-epoch", "edge-capture-1",
    ], output.value, {
      readFile,
      fetch,
      now: () => new Date("2026-08-11T01:00:00.000Z"),
      env: { SNAP_LIVE_TESTS: "1" },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      type: "debug.auth-gap",
      context: "node-bearer",
      status: 401,
    });
    expect(output.stdout.join("\n")).not.toContain("must-not-echo");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
