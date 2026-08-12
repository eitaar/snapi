import { describe, expect, it } from "vitest";
import { ContentRuntimeClient } from "../../src/runtime/worker-client.js";
import type { SessionExport } from "../../src/session/types.js";

function session(accountId = "account-1"): SessionExport {
  return {
    formatVersion: 1,
    accountId,
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

function refreshedSession(accountId = "account-1"): SessionExport {
  return {
    ...session(accountId),
    exportedAt: "2026-08-12T00:00:00.000Z",
    auth: {
      httpToken: "updated-http-token",
      gatewayToken: "updated-gateway-token",
      cookieHeader: "updated-web-cookie",
      ssoCookieHeader: "updated-sso-cookie",
      requestHeaders: { "mcs-cof-ids-bin": "updated-cof-sequence" },
    },
  };
}

function client(timeoutMs = 10_000): ContentRuntimeClient {
  return new ContentRuntimeClient({
    workerUrl: new URL("../fixtures/runtime-worker.ts", import.meta.url),
    timeoutMs,
  });
}

describe("ContentRuntimeClient", () => {
  it("correlates out-of-order responses to their requests", async () => {
    const runtime = client();
    await runtime.initialize(session());
    const slow = runtime.encryptChat({
      recipientId: "r",
      conversationId: "c",
      clientMessageId: "slow-id",
      text: "slow",
    });
    const fast = runtime.createPhotoSnap({
      recipientId: "r",
      conversationId: "c",
      clientMessageId: "fast-id",
      mimeType: "image/png",
      width: 1,
      height: 1,
      bytes: new Uint8Array([1]),
    });

    await expect(fast).resolves.toMatchObject({ contentType: "photo-snap" });
    await expect(slow).resolves.toMatchObject({ contentType: "chat" });
    await runtime.shutdown();
  });

  it("keeps official network access disabled unless explicitly enabled", async () => {
    const disabled = client();
    await expect(disabled.initialize(session("network-option"))).resolves.toMatchObject({
      initializedAt: "false",
    });
    await disabled.shutdown();

    const enabled = new ContentRuntimeClient({
      workerUrl: new URL("../fixtures/runtime-worker.ts", import.meta.url),
      allowNetwork: true,
    });
    await expect(enabled.initialize(session("network-option"))).resolves.toMatchObject({ initializedAt: "true" });
    await enabled.shutdown();
  });

  it("reconstructs typed worker errors", async () => {
    const runtime = client();
    await runtime.initialize(session());
    await expect(runtime.refreshAuth()).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      message: "refresh unavailable",
      details: { safe: true },
    });
    await runtime.shutdown();
  });

  it("requests a safe friend snapshot from the runtime Worker", async () => {
    const runtime = client();
    await runtime.initialize(session());
    await expect(runtime.syncFriends()).resolves.toEqual({
      syncedAt: "2026-08-10T00:00:00.000Z",
      status: "success",
      friends: [],
      incomingRequests: [],
    });
    await runtime.shutdown();
  });

  it("propagates refreshed auth to the existing runtime before the next read-only operation", async () => {
    const runtime = client();
    await runtime.initialize(session());
    await expect(runtime.syncFriends()).resolves.toMatchObject({
      syncedAt: "2026-08-10T00:00:00.000Z",
    });

    await runtime.updateAuth(refreshedSession());

    await expect(runtime.syncFriends()).resolves.toMatchObject({
      syncedAt: "2026-08-12T00:00:00.000Z",
    });
    await runtime.shutdown();
  });

  it("terminates on timeout and rejects later calls", async () => {
    const runtime = client(1_000);
    await runtime.initialize(session());
    await expect(runtime.encryptChat({
      recipientId: "r",
      conversationId: "c",
      clientMessageId: "id",
      text: "timeout",
    })).rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
    await expect(runtime.exportState()).rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
  });

  it("terminates on protocol violation", async () => {
    const runtime = client();
    await expect(runtime.initialize(session("protocol-violation"))).rejects.toMatchObject({
      code: "WORKER_PROTOCOL_ERROR",
    });
    await expect(runtime.exportState()).rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
  });

  it("rejects calls after graceful shutdown", async () => {
    const runtime = client();
    await runtime.initialize(session());
    await runtime.shutdown();
    await expect(runtime.exportState()).rejects.toMatchObject({ code: "CRYPTO_RUNTIME_FAILED" });
  });
});
