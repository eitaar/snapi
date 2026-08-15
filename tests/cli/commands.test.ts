import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile as readFileFromDisk, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main, type ConfiguredCliClient } from "../../src/cli/index.js";
import type { AppConfig } from "../../src/config.js";
import { AppError } from "../../src/errors.js";

const resolvedConfig: AppConfig = {
  sessionFile: "C:/profiles/main-session.json",
  assetDir: "C:/profiles/main-assets",
  lockDir: "C:/profiles/accounts/.locks",
  accountId: "account-1",
  buildId: "8dd50222",
  output: "json",
};

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

function authBindingBaselineHar(token: string, bodyBase64 = "AQID"): object {
  return {
    log: {
      entries: [
        {
          request: { method: "GET", url: "https://web.snapchat.com/web/version.json?version=8dd50222" },
          response: { status: 200 },
        },
        {
          startedDateTime: "2026-08-13T00:00:00.000Z",
          request: {
            method: "GET",
            url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
            headers: [
              { name: "sec-websocket-protocol", value: `snap-ws-auth, ${token}` },
              { name: "origin", value: "https://www.snapchat.com" },
            ],
          },
          response: {
            status: 101,
            headers: [{ name: "sec-websocket-protocol", value: "snap-ws-auth" }],
          },
        },
        {
          startedDateTime: "2026-08-13T00:01:00.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
            httpVersion: "h3",
            headers: [
              { name: "authorization", value: `Bearer ${token}` },
              { name: "content-type", value: "application/grpc-web+proto" },
            ],
            postData: { encoding: "base64", text: bodyBase64 },
          },
          response: { status: 200 },
        },
      ],
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

function withResolvedConfig<T extends Record<string, unknown>>(dependencies: T): T & {
  readonly resolveConfig: () => Promise<AppConfig>;
} {
  return {
    ...dependencies,
    resolveConfig: async () => resolvedConfig,
  };
}

describe("CLI commands", () => {
  it("routes chat send with an explicit conversation and does not echo plaintext", async () => {
    const output = io();
    const state = configured();
    const createClient = vi.fn(async () => state);
    const code = await main([
      "chat", "send", "recipient-id", "private message", "--conversation-id", "conversation-id",
    ], output.value, withResolvedConfig({ createClient }));

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

  it("keeps a confirmed chat send successful when cleanup fails", async () => {
    const output = io();
    const state = configured({
      close: vi.fn(async () => {
        throw new Error("worker cleanup timed out");
      }),
    });
    const code = await main([
      "chat", "send", "recipient-id", "private message", "--conversation-id", "conversation-id",
    ], output.value, withResolvedConfig({ createClient: async () => state }));

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ type: "chat.sent", status: "confirmed" });
    expect(output.stderr.join("\n")).toContain("cleanup");
  });

  it("returns usage code without creating a client when conversation-id is missing", async () => {
    const output = io();
    const createClient = vi.fn();
    await expect(main(["chat", "send", "recipient", "text"], output.value, { createClient }))
      .resolves.toBe(2);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("passes the resolved config to the client factory exactly once and strips the global account option", async () => {
    const output = io();
    const state = configured();
    const config: AppConfig = {
      sessionFile: "C:/profiles/bot-session.json",
      assetDir: "C:/profiles/bot-assets",
      lockDir: "C:/profiles/accounts/.locks",
      accountId: "account-bot",
      buildId: "8dd50222",
      output: "json",
      accountAlias: "bot",
    };
    const resolveConfig = vi.fn(async (accountAlias?: string) => {
      expect(accountAlias).toBe("bot");
      return config;
    });
    const createClient = vi.fn(async (receivedConfig?: AppConfig) => {
      expect(receivedConfig).toBe(config);
      return state;
    });

    const code = await main([
      "--account", "bot",
      "chat", "send", "recipient-id", "private message", "--conversation-id", "conversation-id",
    ], output.value, { resolveConfig, createClient, env: { SNAAPI_ACCOUNT: "main" } });

    expect(code).toBe(0);
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(state.client.sendText).toHaveBeenCalledWith({
      recipientId: "recipient-id",
      conversationId: "conversation-id",
      text: "private message",
    });
  });

  it("does not resolve an account for --version and does not mutate process.env", async () => {
    const stdout: string[] = [];
    const resolveConfig = vi.fn();
    const createClient = vi.fn();
    const originalAccount = process.env.SNAAPI_ACCOUNT;
    process.env.SNAAPI_ACCOUNT = "main";

    try {
      const code = await main(["--version"], {
        version: "0.1.0",
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      }, { resolveConfig, createClient });

      expect(code).toBe(0);
      expect(stdout).toEqual(["0.1.0"]);
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(process.env.SNAAPI_ACCOUNT).toBe("main");
    } finally {
      if (originalAccount === undefined) delete process.env.SNAAPI_ACCOUNT;
      else process.env.SNAAPI_ACCOUNT = originalAccount;
    }
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
    ], output.value, withResolvedConfig({ createClient: async () => state }));
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
    ], output.value, withResolvedConfig({
      createClient: async () => state,
      readFile: async () => bytes,
    }));
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

  it("keeps a confirmed photo Snap successful when cleanup fails", async () => {
    const output = io();
    const state = configured({
      close: vi.fn(async () => {
        throw new Error("worker cleanup timed out");
      }),
    });
    const code = await main(
      ["snap", "send", "recipient", "photo.png", "--conversation-id", "conversation"],
      output.value,
      withResolvedConfig({
        createClient: async () => state,
        readFile: async () => new Uint8Array([1, 2, 3]),
      }),
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ type: "snap.sent", status: "confirmed" });
    expect(output.stderr.join("\n")).toContain("cleanup");
  });

  it("connects the Gateway and prints its live status", async () => {
    const output = io();
    const state = configured();
    const code = await main(["gateway", "status"], output.value, {
      createGatewayStatusClient: async () => state,
    });
    expect(code).toBe(0);
    expect(state.client.watchEvents).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout[0]!)).toEqual({ type: "gateway.status", status: "open" });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("uses the dedicated Gateway status factory without creating the full messaging client", async () => {
    const output = io();
    const state = configured();
    const createClient = vi.fn(async () => state);
    const code = await main(["gateway", "status"], output.value, {
      createClient,
      createGatewayStatusClient: async () => state,
    });

    expect(code).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(state.client.watchEvents).toHaveBeenCalledOnce();
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("routes read-only friend listing", async () => {
    const output = io();
    const state = configured();
    const code = await main(["friends", "list"], output.value, withResolvedConfig({
      createClient: async () => state,
    }));

    expect(code).toBe(0);
    expect(state.client.listFriends).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ type: "friends.list", status: "success" });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it("prints intended incoming plaintext only for chat watch", async () => {
    const output = io();
    const state = configured();
    const code = await main(["chat", "watch", "--json"], output.value, withResolvedConfig({
      createClient: async () => state,
    }));
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
    const readFile = vi.fn(async (path: string) => {
      const normalized = path.replaceAll("\\", "/");
      if (normalized.endsWith("/private/session.json")) return encoded.get("private/session.json")!;
      return encoded.get(path)!;
    });
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
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "json",
      },
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

  it("rejects auth-gap use of a session file outside the configured session", async () => {
    const output = io();
    const readFile = vi.fn();
    const fetch = vi.fn();

    const code = await main([
      "debug", "auth-gap",
      "--request", "private/request.json",
      "--session", "private/other-session.json",
      "--mode", "node-bearer",
      "--auth-epoch", "edge-capture-1",
    ], output.value, {
      readFile,
      fetch,
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
      },
    });

    expect(code).toBe(3);
    expect(output.stderr.join("\n")).toContain("configured session");
    expect(readFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects auth-gap credentials from another configured account", async () => {
    const output = io();
    const mismatchedSession = {
      formatVersion: 1,
      accountId: "other-account",
      buildId: "8dd50222",
      exportedAt: "2026-08-11T00:00:00.000Z",
      auth: {
        httpToken: "other-account-token-secret",
        gatewayToken: "other-account-gateway-secret",
        cookieHeader: "other-account-cookie-secret",
        requestHeaders: {},
      },
      assets: [],
      localStorage: {},
      indexedDb: { databases: [] },
    };
    const request = {
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      headers: {},
      bodyBase64: Buffer.from([1]).toString("base64"),
    };
    const readFile = vi.fn(async (path: string) =>
      new TextEncoder().encode(JSON.stringify(path.includes("request") ? request : mismatchedSession)));
    const fetch = vi.fn();

    const code = await main([
      "debug", "auth-gap",
      "--request", "private/request.json",
      "--session", "private/session.json",
      "--mode", "node-bearer",
      "--auth-epoch", "edge-capture-1",
    ], output.value, {
      readFile,
      fetch,
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
      },
    });

    expect(code).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).not.toContain("other-account-token-secret");
    expect(output.stderr.join("\n")).not.toContain("other-account-cookie-secret");
  });

  it("summarizes an in-scope HAR offline without returning credential values", async () => {
    const output = io();
    const token = "a".repeat(64);
    const cookie = "session=har-cookie-sentinel";
    const har = {
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://web.snapchat.com/web/version.json?version=8dd50222" },
            response: { status: 200 },
          },
          {
            startedDateTime: "2026-08-13T00:00:00.000Z",
            request: {
              method: "GET",
              url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
              headers: [
                { name: "sec-websocket-protocol", value: `snap-ws-auth, ${token}` },
                { name: "cookie", value: cookie },
                { name: "origin", value: "https://www.snapchat.com" },
              ],
            },
            response: {
              status: 101,
              headers: [{ name: "sec-websocket-protocol", value: "snap-ws-auth" }],
            },
          },
          {
            startedDateTime: "2026-08-13T00:01:00.000Z",
            request: {
              method: "POST",
              url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
              httpVersion: "h2",
              headers: [
                { name: "authorization", value: `Bearer ${token}` },
                { name: "content-type", value: "application/grpc-web+proto" },
              ],
              postData: { encoding: "base64", text: "AQID" },
            },
            response: { status: 200 },
          },
        ],
      },
    };
    const readFile = vi.fn(async () => new TextEncoder().encode(JSON.stringify(har)));

    const code = await main([
      "debug", "auth-binding", "har", "--file", "private/capture.har", "--epoch", "epoch-a",
    ], output.value, {
      readFile,
      env: {
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "json",
      },
      debugAuthBinding: { realpath: async (path) => path },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      type: "debug.auth-binding.har",
      buildId: "8dd50222",
      gateway101Count: 1,
      messagingSuccessCount: 1,
    });
    expect(output.stdout.join("\n")).not.toContain(token);
    expect(output.stdout.join("\n")).not.toContain(cookie);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("blocks auth-binding probes before reading files or using a transport when live tests are disabled", async () => {
    const output = io();
    const readFile = vi.fn();
    const fetch = vi.fn();
    const readSealedSession = vi.fn();
    const originalLoadEnvFile = process.loadEnvFile;
    const loadEnvFile = vi.fn();
    const originalLiveTests = process.env.SNAP_LIVE_TESTS;
    delete process.env.SNAP_LIVE_TESTS;
    process.loadEnvFile = loadEnvFile;

    try {
      const code = await main([
        "debug", "auth-binding", "probe", "--request", "private/request.json", "--mode", "node-http1", "--epoch", "epoch-a",
      ], output.value, { readFile, fetch, debugAuthBinding: { readSealedSession } });

      expect(code).toBe(3);
      expect(output.stderr.join("\n")).toContain("INVALID_CONFIG");
      expect(readFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(readSealedSession).not.toHaveBeenCalled();
      expect(loadEnvFile).not.toHaveBeenCalled();
    } finally {
      process.loadEnvFile = originalLoadEnvFile;
      if (originalLiveTests === undefined) delete process.env.SNAP_LIVE_TESTS;
      else process.env.SNAP_LIVE_TESTS = originalLiveTests;
    }
  });

  it("rejects unsafe auth-binding epochs before any read, session, transport, or output", async () => {
    const secret = "Bearer secret";
    const env = {
      SNAP_LIVE_TESTS: "1",
      SNAP_SESSION_FILE: "private/session.json",
      SNAP_ASSET_DIR: "private/assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_OUTPUT: "json",
    };
    const cases: readonly (readonly string[])[] = [
      ["debug", "auth-binding", "har", "--file", "private/capture.har", "--epoch", secret],
      ["debug", "auth-binding", "probe", "--request", "private/request.json", "--mode", "node-http1", "--epoch", secret],
      ["debug", "auth-binding", "gateway", "--mode", "node-gateway", "--epoch", secret],
    ];

    for (const argv of cases) {
      const output = io();
      const readFile = vi.fn();
      const fetch = vi.fn();
      const readSealedSession = vi.fn();
      const code = await main(argv, output.value, {
        readFile,
        fetch,
        env,
        debugAuthBinding: { readSealedSession },
      });
      const emitted = `${output.stdout.join("\n")}\n${output.stderr.join("\n")}`;

      expect(code).toBe(3);
      expect(readFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(readSealedSession).not.toHaveBeenCalled();
      expect(emitted).not.toContain(secret);
    }
  });

  it("rejects an auth-binding file that resolves outside the configured private directory", async () => {
    const output = io();
    const readFile = vi.fn();
    const realpath = vi.fn(async (path: string) => path.endsWith("capture.har")
      ? resolve("outside", "capture.har")
      : resolve("private"));

    const code = await main([
      "debug", "auth-binding", "har", "--file", "private/capture.har", "--epoch", "epoch-a",
    ], output.value, {
      readFile,
      env: {
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "json",
      },
      debugAuthBinding: { realpath },
    });

    expect(code).toBe(3);
    expect(realpath).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
  });

  it("classifies the tracked sanitized observations offline", async () => {
    const output = io();
    const fixture = join(process.cwd(), "tests", "fixtures", "auth-binding-observations.json");
    const readFile = vi.fn(async () => new Uint8Array(await readFileFromDisk(fixture)));

    const code = await main([
      "debug", "auth-binding", "classify", "--observations", fixture,
    ], output.value, { readFile, env: { SNAP_OUTPUT: "json" } });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      type: "debug.auth-binding",
      conclusion: { kind: "tls-client-bound", operation: "messaging-read" },
    });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("accepts the sanitized HTTP/3 probe schema through the real classifier CLI", async () => {
    const output = io();
    const observation = {
      authEpoch: "fresh-http3",
      context: "dotnet-http3",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T01:00:02.000Z",
      status: 401,
      protocol: "h3",
      requestBodyBytes: 3,
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: ["authorization", "content-type", "x-grpc-web"],
      tokenEqualsEpochBaseline: true,
    };
    const readFile = vi.fn(async () => new TextEncoder().encode(JSON.stringify([observation])));

    const code = await main([
      "debug", "auth-binding", "classify", "--observations", "private/http3-observation.json",
    ], output.value, { readFile, env: { SNAP_OUTPUT: "json" } });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      type: "debug.auth-binding",
      conclusion: { kind: "insufficient-evidence", operation: "messaging-read" },
    });
  });

  it.each([
    ["Messaging body bytes are missing", {
      authEpoch: "epoch-a",
      context: "node-http2",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "h2",
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: ["authorization"],
      tokenEqualsEpochBaseline: false,
    }],
    ["Messaging body hash is missing", {
      authEpoch: "epoch-a",
      context: "node-http2",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "h2",
      requestBodyBytes: 3,
      safeHeaderNames: ["authorization"],
      tokenEqualsEpochBaseline: false,
    }],
    ["Gateway context is used for Messaging", {
      authEpoch: "epoch-a",
      context: "node-gateway",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "h2",
      requestBodyBytes: 3,
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: [],
      tokenEqualsEpochBaseline: false,
    }],
    ["Messaging endpoint is used for Gateway", {
      authEpoch: "epoch-a",
      context: "node-gateway",
      operation: "gateway-handshake",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "websocket",
      safeHeaderNames: [],
      tokenEqualsEpochBaseline: false,
    }],
    ["HTTP/3 context reports h2", {
      authEpoch: "epoch-a",
      context: "dotnet-http3",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "h2",
      requestBodyBytes: 3,
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: ["authorization"],
      tokenEqualsEpochBaseline: true,
    }],
    ["Gateway carries Messaging body identity", {
      authEpoch: "epoch-a",
      context: "node-gateway",
      operation: "gateway-handshake",
      endpointPath: "/snapchat.gateway.Gateway/WebSocketConnect",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 401,
      protocol: "websocket",
      requestBodyBytes: 3,
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: [],
      tokenEqualsEpochBaseline: false,
    }],
    ["bootstrap label is unbounded", {
      authEpoch: "epoch-a",
      context: "brave-worker-replay",
      operation: "messaging-read",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      startedAt: "2026-08-13T00:00:00.000Z",
      status: 200,
      protocol: "h3",
      requestBodyBytes: 3,
      requestBodySha256: "a".repeat(64),
      safeHeaderNames: ["authorization"],
      tokenEqualsEpochBaseline: true,
      bootstrapStage: "ready",
    }],
  ])("rejects a non-discriminated auth-binding observation when %s", async (_reason, observation) => {
    const output = io();
    const readFile = vi.fn(async () => new TextEncoder().encode(JSON.stringify([observation])));

    const code = await main([
      "debug", "auth-binding", "classify", "--observations", "private/invalid-observation.json",
    ], output.value, { readFile, env: { SNAP_OUTPUT: "json" } });

    expect(code).toBe(3);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("\n")).toContain("INVALID_CONFIG");
  });

  it("rejects unsafe auth-binding paths and malformed flags", async () => {
    const env = {
      SNAP_LIVE_TESTS: "1",
      SNAP_SESSION_FILE: "private/session.json",
      SNAP_ASSET_DIR: "private/assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_OUTPUT: "json",
    };
    const cases: readonly (readonly string[])[] = [
      ["debug", "auth-binding", "har", "--file", join(tmpdir(), "outside.har"), "--epoch", "epoch-a"],
      ["debug", "auth-binding", "probe", "--request", "private/request.json", "--mode", "invalid", "--epoch", "epoch-a"],
      ["debug", "auth-binding", "har", "--file", "private/capture.har", "--file", "private/again.har", "--epoch", "epoch-a"],
      ["debug", "auth-binding", "gateway", "--mode", "node-gateway"],
    ];

    for (const argv of cases) {
      const output = io();
      const readFile = vi.fn();
      const code = await main(argv, output.value, { readFile, env });
      expect(code).toBe(3);
      expect(output.stderr.join("\n")).toContain("INVALID_CONFIG");
      expect(readFile).not.toHaveBeenCalled();
    }
  });

  it("runs each valid auth-binding probe once without emitting session credentials", async () => {
    const output = io();
    const sharedToken = "t".repeat(64);
    const session = {
      accountId: "account-1",
      buildId: "8dd50222",
      auth: {
        httpToken: sharedToken,
        cookieHeader: "cookie-sentinel",
        gatewayToken: sharedToken,
      },
    };
    const request = {
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      headers: { accept: "application/grpc-web+proto" },
      bodyBase64: "AQID",
    };
    const baselineHar = authBindingBaselineHar(session.auth.httpToken);
    const readFile = vi.fn(async (path: string) => new TextEncoder().encode(JSON.stringify(
      path.includes("baseline") ? baselineHar : request,
    )));
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    const gatewayProbe = vi.fn(async () => ({
      status: 101,
      classification: "open" as const,
      protocol: "snap-ws-auth" as const,
      headerNames: [],
      durationMs: 1,
    }));
    const readSealedSession = vi.fn(async () => session as never);
    const dependencies = {
      readFile,
      fetch,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "json",
      },
      debugAuthBinding: { readSealedSession, gatewayProbe, realpath: async (path: string) => path },
    };

    await expect(main([
      "debug", "auth-binding", "probe",
      "--request", "private/request.json",
      "--baseline-har", "private/baseline.har",
      "--mode", "node-http1",
      "--epoch", "epoch-a",
    ], output.value, dependencies)).resolves.toBe(0);
    await expect(main([
      "debug", "auth-binding", "gateway",
      "--baseline-har", "private/baseline.har",
      "--mode", "node-gateway",
      "--epoch", "epoch-a",
    ], output.value, dependencies)).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledOnce();
    expect(gatewayProbe).toHaveBeenCalledOnce();
    expect(readSealedSession).toHaveBeenCalledTimes(2);
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ tokenEqualsEpochBaseline: true }),
      expect.objectContaining({ tokenEqualsEpochBaseline: true }),
    ]);
    const emitted = `${output.stdout.join("\n")}\n${output.stderr.join("\n")}`;
    expect(emitted).not.toContain(sharedToken);
    expect(emitted).not.toContain("cookie-sentinel");
  });

  it("rejects a stale auth-binding baseline before opening a live transport", async () => {
    const output = io();
    const session = {
      accountId: "account-1",
      buildId: "8dd50222",
      auth: {
        httpToken: "a".repeat(64),
        cookieHeader: "cookie-sentinel",
        gatewayToken: "a".repeat(64),
      },
    };
    const request = {
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      headers: { accept: "application/grpc-web+proto" },
      bodyBase64: "AQID",
    };
    const readFile = vi.fn(async (path: string) => new TextEncoder().encode(JSON.stringify(
      path.includes("baseline") ? authBindingBaselineHar("b".repeat(64)) : request,
    )));
    const fetch = vi.fn();
    const readSealedSession = vi.fn(async () => session as never);

    const code = await main([
      "debug", "auth-binding", "probe",
      "--request", "private/request.json",
      "--baseline-har", "private/baseline.har",
      "--mode", "node-http1",
      "--epoch", "epoch-a",
    ], output.value, {
      readFile,
      fetch,
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "json",
      },
      debugAuthBinding: { readSealedSession, realpath: async (path: string) => path },
    });

    expect(code).toBe(3);
    expect(readSealedSession).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("\n")).not.toContain("a".repeat(64));
    expect(output.stderr.join("\n")).not.toContain("b".repeat(64));
  });
});
