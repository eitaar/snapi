import { describe, expect, it, vi } from "vitest";
import { OfficialWorkerClient } from "../../src/runtime/official-worker-client.js";
import { toRuntimeAuthUpdate } from "../../src/runtime/protocol.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "11111111-1111-4111-8111-111111111111",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: {
      httpToken: "test-token",
      gatewayToken: "test-token",
      cookieHeader: "test-cookie",
      requestHeaders: {},
    },
    assets: [],
    localStorage: {},
    sessionStorage: {},
    indexedDb: { databases: [] },
    messaging: {
      keyInitializationInfo: "AQID",
      rootWrappingKey: { data: "BAUG", identityKeyId: "BwgJ" },
      friendDevices: {
        "11111111-1111-4111-8111-111111111111": [{ deviceId: "device-1" }],
      },
    },
  };
}

function refreshedSession(): SessionExport {
  return {
    ...session(),
    exportedAt: "2026-08-12T00:00:00.000Z",
    auth: {
      httpToken: "refreshed-official-http-token",
      gatewayToken: "refreshed-official-gateway-token",
      cookieHeader: "refreshed-web-cookie",
      ssoCookieHeader: "refreshed-sso-cookie",
      requestHeaders: { "mcs-cof-ids-bin": "refreshed-cof-sequence" },
    },
  };
}

describe("official messaging session", () => {
  it("updates in-memory auth for the next read-only official operation", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-session-contract-worker.mjs", import.meta.url),
    });
    try {
      await client.initializeWasm(session());
      await client.updateAuth(toRuntimeAuthUpdate(refreshedSession()));
      await expect(client.syncFriends()).resolves.toEqual({
        syncedAt: "2026-08-12T00:00:00.000Z",
        status: "success",
        friends: [],
        incomingRequests: [],
      });
    } finally {
      await client.shutdown();
    }
  });

  it("maps a worker-boundary Friends authorization failure to a sanitized session expiry", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-session-expired-worker.mjs", import.meta.url),
    });
    try {
      await client.initializeWasm(session());
      const error = await client.syncFriends().catch((value: unknown) => value);

      expect(error).toMatchObject({
        code: "SESSION_EXPIRED",
        message: "Official friend synchronization was unauthorized",
        details: {},
      });
      expect(JSON.stringify(error)).not.toContain("raw-transport-secret");
    } finally {
      await client.shutdown();
    }
  });

  it("rejects initialization when the official Worker fails before ready", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/missing-official-worker.mjs", import.meta.url),
    });
    try {
      await expect(client.initializeWasm(session())).rejects.toMatchObject({
        code: "CRYPTO_RUNTIME_FAILED",
      });
    } finally {
      await client.shutdown();
    }
  });

  it("restores key material and friend devices through the observed 18-argument contract", async () => {
    const onMessage = vi.fn();
    const onFeedEntriesUpdated = vi.fn();
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-session-contract-worker.mjs", import.meta.url),
      onMessage,
      feedDelegate: { onFeedEntriesUpdated },
    });
    try {
      const manager = await client.initializeMessagingSession(session());
      await expect(manager.call<boolean>(["ready"])).resolves.toBe(true);
      await expect(client.syncFriends()).resolves.toEqual({
        syncedAt: "2026-08-12T00:00:00.000Z",
        status: "success",
        friends: [],
        incomingRequests: [],
      });
      await client.syncFeed(7);
      expect(onMessage).toHaveBeenCalledWith({
        messageId: "received-message",
        conversationId: "received-conversation",
        senderId: "received-sender",
      });
      expect(onFeedEntriesUpdated).toHaveBeenCalledWith(
        [{ id: "feed-entry", content: { text: "received plaintext" } }],
        "conversation",
        7,
        false,
      );
    } finally {
      await client.shutdown();
    }
  });

  it("restores the pre-login temporary identity for first-session initialization", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-session-contract-worker.mjs", import.meta.url),
    });
    const base = session();
    const bootstrap: SessionExport = {
      ...base,
      sessionStorage: { e2eeTempKey: "opaque serialized temporary identity" },
      messaging: { keyInitializationInfo: base.messaging!.keyInitializationInfo!,
        friendDevices: base.messaging!.friendDevices },
    };
    try {
      const manager = await client.initializeMessagingSession(bootstrap);
      await expect(manager.call<boolean>(["ready"])).resolves.toBe(true);
      expect(client.exportMessagingState()).toEqual({
        localStorage: { "identity-state": "persisted" },
        sessionStorage: { "session-state": "persisted" },
        rootWrappingKey: {
          data: "CQkJ",
          identityKeyId: "CAg=",
        },
      });
    } finally {
      await client.shutdown();
    }
  });

  it("requires the login-time messaging state before starting the official session", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/official-session-contract-worker.mjs", import.meta.url),
    });
    const missing = { ...session(), messaging: undefined } as unknown as SessionExport;
    try {
      await expect(client.initializeMessagingSession(missing)).rejects.toMatchObject({
        code: "SESSION_REEXPORT_REQUIRED",
      });
    } finally {
      await client.shutdown();
    }
  });
});
