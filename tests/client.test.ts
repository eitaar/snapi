import { describe, expect, it, vi } from "vitest";
import { SnapchatClient, type SnapchatClientComponents } from "../src/client.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  sessionFile: "session.json",
  assetDir: "assets",
  lockDir: "locks",
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
      snaps: vi.fn(() => (async function* () {
        yield {
          type: "snap.received" as const,
          senderId: "sender",
          conversationId: "conversation",
          messageId: "snap-message",
          timestamp: "now",
          media: [{
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "image/jpeg",
            hasAudio: false,
          }],
        };
      })()),
    },
    media: {
      sendPhotoSnap: vi.fn(async () => ({ clientMessageId: "photo-id", status: "confirmed" as const })),
    },
    friends: {
      list: vi.fn(async () => ({
        syncedAt: "2026-08-12T00:00:00.000Z",
        status: "success" as const,
        friends: [],
        incomingRequests: [],
      })),
      listEasy: vi.fn(async () => ({ friends: [] })),
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

  it("delegates read-only friend listing", async () => {
    const state = components([]);
    const client = await SnapchatClient.create(config, { compose: async () => state });
    await expect(client.listFriends()).resolves.toMatchObject({ status: "success" });
    expect(state.friends.list).toHaveBeenCalledOnce();
    await client.close();
  });

  it("delegates send-ready easy friend listing", async () => {
    const state = components([]);
    state.friends.listEasy = vi.fn(async () => ({
      friends: [{ recipientId: "recipient", conversationId: "conversation" }],
    }));
    const client = await SnapchatClient.create(config, { compose: async () => state });

    await expect(client.listEasyFriends()).resolves.toEqual({
      friends: [{ recipientId: "recipient", conversationId: "conversation" }],
    });
    expect(state.friends.listEasy).toHaveBeenCalledOnce();
    await client.close();
  });

  it("delegates incoming Snap watching when the messaging component exposes it", async () => {
    const state = components([]);
    const client = await SnapchatClient.create(config, { compose: async () => state });

    const iterator = client.watchSnaps();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        type: "snap.received",
        messageId: "snap-message",
      }),
    });
    expect(state.messaging.snaps).toHaveBeenCalledOnce();

    await iterator.return?.();
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

  it("persists refreshed auth before updating the runtime and retrying a read-only friend sync", async () => {
    vi.resetModules();
    const { AppError } = await import("../src/errors.js");
    const initialSession = {
      formatVersion: 1 as const,
      accountId: "account",
      buildId: "8dd50222" as const,
      exportedAt: "2026-08-12T00:00:00.000Z",
      auth: {
        httpToken: "initial-http-token",
        gatewayToken: "initial-gateway-token",
        tokenRefreshedAt: "2099-08-12T00:00:00.000Z",
        cookieHeader: "initial-web-cookie",
        ssoCookieHeader: "initial-sso-cookie",
        requestHeaders: { "mcs-cof-ids-bin": "initial-cof-sequence" },
      },
      assets: [],
      localStorage: {},
      sessionStorage: {},
      indexedDb: { databases: [] },
    };
    const refreshedSession = {
      ...initialSession,
      exportedAt: "2026-08-12T00:05:00.000Z",
      auth: {
        httpToken: "refreshed-http-token",
        gatewayToken: "refreshed-gateway-token",
        cookieHeader: "refreshed-web-cookie",
        ssoCookieHeader: "refreshed-sso-cookie",
        requestHeaders: { "mcs-cof-ids-bin": "refreshed-cof-sequence" },
      },
    };
    const snapshot = {
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success" as const,
      friends: [],
      incomingRequests: [],
    };
    const events: string[] = [];
    let persisted = initialSession;
    let runtimeUpdated = false;
    const lock = {
      path: "lock",
      release: vi.fn(async () => { events.push("lock.release"); }),
      [Symbol.asyncDispose]: async () => undefined,
    };
    const runtime = {
      initialize: vi.fn(async () => {
        events.push("runtime.initialize");
        return { buildId: "8dd50222", initializedAt: "2026-08-12T00:00:00.000Z" };
      }),
      updateAuth: vi.fn(async () => {
        events.push("runtime.updateAuth");
        runtimeUpdated = true;
      }),
      syncFriends: vi.fn(async () => {
        events.push("runtime.syncFriends");
        if (!runtimeUpdated) throw new AppError("SESSION_EXPIRED", "friend sync expired");
        return snapshot;
      }),
      shutdown: vi.fn(async () => { events.push("runtime.shutdown"); }),
    };

    vi.doMock("../src/session/loader.js", () => ({
      loadSession: vi.fn(async () => persisted),
    }));
    vi.doMock("../src/compat/asset-loader.js", () => ({
      AssetLoader: class {},
    }));
    vi.doMock("../src/compat/guard.js", () => ({
      CompatibilityGuard: class {
        async verify(): Promise<void> {
          events.push("compat.verify");
        }
      },
    }));
    vi.doMock("../src/session/account-lock.js", () => ({
      AccountLock: class {
        async acquire() {
          events.push("lock.acquire");
          return lock;
        }
      },
    }));
    vi.doMock("../src/session/state-store.js", () => ({
      AtomicJsonStore: class {
        async read() {
          events.push("store.read");
          return persisted;
        }

        async write(value: typeof persisted) {
          events.push("store.write");
          persisted = value;
        }
      },
    }));
    vi.doMock("../src/session/sealed-store.js", () => ({
      SealedSessionStore: class {
        async readOrMigrateLegacy() {
          events.push("store.read");
          return persisted;
        }

        async read() {
          events.push("store.read");
          return persisted;
        }

        async write(value: typeof persisted) {
          events.push("store.write");
          persisted = value;
        }
      },
    }));
    vi.doMock("../src/runtime/worker-client.js", () => ({
      ContentRuntimeClient: class {
        initialize = runtime.initialize;
        updateAuth = runtime.updateAuth;
        syncFriends = runtime.syncFriends;
        shutdown = runtime.shutdown;
      },
    }));
    vi.doMock("../src/transport/sso-auth-refresh.js", () => ({
      refreshSnapchatSession: vi.fn(async () => {
        events.push("auth.refresh");
        return refreshedSession;
      }),
    }));
    vi.doMock("../src/transport/grpc-client.js", () => ({
      GrpcWebClient: class {},
    }));
    vi.doMock("../src/messaging/client.js", () => ({
      MessagingClient: class {
        sendText = vi.fn(async () => ({ clientMessageId: "message-id", status: "confirmed" as const }));
        messages = vi.fn(() => (async function* () {})());
      },
    }));
    vi.doMock("../src/media/client.js", () => ({
      MediaClient: class {
        sendPhotoSnap = vi.fn(async () => ({ clientMessageId: "photo-id", status: "confirmed" as const }));
      },
    }));
    vi.doMock("../src/gateway/client.js", () => ({
      GatewayClient: class {
        async connect(): Promise<void> {}
        async close(): Promise<void> { events.push("gateway.close"); }
        status() { return "idle" as const; }
        async *events() {}
      },
    }));

    const { SnapchatClient: ComposeDefaultClient } = await import("../src/client.js");
    const client = await ComposeDefaultClient.create(config);
    expect(events).not.toContain("runtime.updateAuth");

    await expect(client.listFriends()).resolves.toEqual(snapshot);

    expect(runtime.updateAuth).toHaveBeenCalledOnce();
    expect(events.indexOf("store.write")).toBeGreaterThan(events.indexOf("store.read"));
    expect(events.indexOf("runtime.updateAuth")).toBeGreaterThan(events.indexOf("store.write"));
    expect(events.lastIndexOf("runtime.syncFriends")).toBeGreaterThan(events.indexOf("runtime.updateAuth"));
    expect(persisted.exportedAt).toBe("2026-08-12T00:05:00.000Z");

    await client.close();
  });

  it("uses config.lockDir for the account lock root", async () => {
    vi.resetModules();
    const events: string[] = [];
    const initialSession = {
      formatVersion: 1 as const,
      accountId: "account",
      buildId: "8dd50222" as const,
      exportedAt: "2026-08-12T00:00:00.000Z",
      auth: {
        httpToken: "initial-http-token",
        gatewayToken: "initial-gateway-token",
        tokenRefreshedAt: "2099-08-12T00:00:00.000Z",
        cookieHeader: "initial-web-cookie",
        ssoCookieHeader: "initial-sso-cookie",
        requestHeaders: { "mcs-cof-ids-bin": "initial-cof-sequence" },
      },
      assets: [],
      localStorage: {},
      sessionStorage: {},
      indexedDb: { databases: [] },
    };
    const constructedLockDirs: string[] = [];
    const lock = {
      path: "lock",
      release: vi.fn(async () => { events.push("lock.release"); }),
      [Symbol.asyncDispose]: async () => undefined,
    };

    vi.doMock("../src/session/sealed-store.js", () => ({
      SealedSessionStore: class {
        async readOrMigrateLegacy() {
          return initialSession;
        }

        async read() {
          return initialSession;
        }

        async write() {}
      },
    }));
    vi.doMock("../src/session/account-lock.js", () => ({
      AccountLock: class {
        constructor(lockDir: string) {
          constructedLockDirs.push(lockDir);
        }

        async acquire() {
          return lock;
        }
      },
    }));
    vi.doMock("../src/compat/asset-loader.js", () => ({
      AssetLoader: class {},
    }));
    vi.doMock("../src/compat/guard.js", () => ({
      CompatibilityGuard: class {
        async verify(): Promise<void> {}
      },
    }));
    vi.doMock("../src/runtime/worker-client.js", () => ({
      ContentRuntimeClient: class {
        async initialize() {
          return { buildId: "8dd50222", initializedAt: "2026-08-12T00:00:00.000Z" };
        }

        async shutdown() {
          events.push("runtime.shutdown");
        }
      },
    }));
    vi.doMock("../src/transport/grpc-client.js", () => ({
      GrpcWebClient: class {},
    }));
    vi.doMock("../src/messaging/client.js", () => ({
      MessagingClient: class {
        sendText = vi.fn(async () => ({ clientMessageId: "message-id", status: "confirmed" as const }));
        messages = vi.fn(() => (async function* () {})());
      },
    }));
    vi.doMock("../src/media/client.js", () => ({
      MediaClient: class {
        sendPhotoSnap = vi.fn(async () => ({ clientMessageId: "photo-id", status: "confirmed" as const }));
      },
    }));
    vi.doMock("../src/friends/client.js", () => ({
      FriendsClient: class {
        list = vi.fn(async () => ({
          syncedAt: "2026-08-12T00:00:00.000Z",
          status: "success" as const,
          friends: [],
          incomingRequests: [],
        }));

        listEasy = vi.fn(async () => ({ friends: [] }));
      },
    }));
    vi.doMock("../src/gateway/client.js", () => ({
      GatewayClient: class {
        async connect(): Promise<void> {}
        async close(): Promise<void> {}
        status() { return "idle" as const; }
        async *events() {}
      },
    }));

    const { SnapchatClient: ComposeDefaultClient } = await import("../src/client.js");
    const client = await ComposeDefaultClient.create({
      ...config,
      sessionFile: "nested/session.json",
      lockDir: "shared/profile-locks",
    });

    expect(constructedLockDirs).toEqual(["shared/profile-locks"]);

    await client.close();
  });
});
