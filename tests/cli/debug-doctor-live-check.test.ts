import { describe, expect, it, vi } from "vitest";
import { runLiveCheck, type LiveContext } from "../../src/cli/commands/debug-doctor.js";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";

function context(): LiveContext {
  const config: AppConfig = {
    sessionFile: "session.json",
    assetDir: "assets",
    accountId: "account-1",
    buildId: "8dd50222",
    output: "human",
  };
  const session: SessionExport = {
    formatVersion: 1,
    accountId: "account-1",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
  return { config, session, reportAssets: [] };
}

describe("runtime doctor live checks", () => {
  it("executes every pre-send check through injected offline dependencies", async () => {
    const state = context();
    const refreshedSession: SessionExport = {
      ...state.session,
      exportedAt: "2026-08-11T01:02:03.000Z",
      auth: { ...state.session.auth, httpToken: "refreshed", gatewayToken: "refreshed" },
    };
    const runtime = {
      initialize: vi.fn(async () => ({ buildId: "8dd50222" })),
      encryptChat: vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: "chat" as const })),
      exportState: vi.fn(async () => ({ localStorage: {}, sessionStorage: {}, indexedDb: { databases: [] } })),
      shutdown: vi.fn(async () => undefined),
    };
    const dependencies = {
      verifyAssets: vi.fn(async () => [{ filename: "bundle.js", sha256: "a".repeat(64), size: 1 }]),
      refreshSession: vi.fn(async () => refreshedSession),
      createRuntime: vi.fn(() => runtime),
      env: {
        SNAP_TEST_RECIPIENT_ID: "recipient",
        SNAP_TEST_CONVERSATION_ID: "conversation",
      },
      randomUuid: () => "message-id",
      now: () => 123,
    };

    for (const name of [
      "assets_verified", "worker_started", "globals_installed", "storage_imported",
      "wasm_instantiated", "modules_resolved", "content_envelope_created", "state_exported",
      "managed_reply_decrypted",
    ] as const) {
      await runLiveCheck(state, name, dependencies);
    }

    expect(state.reportAssets).toHaveLength(1);
    expect(dependencies.createRuntime).toHaveBeenCalledWith("assets");
    expect(dependencies.refreshSession).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ httpToken: "x" }),
    }));
    expect(state.session).toBe(refreshedSession);
    expect(runtime.initialize).toHaveBeenCalledWith(refreshedSession);
    expect(runtime.encryptChat).toHaveBeenCalledWith({
      recipientId: "recipient",
      conversationId: "conversation",
      clientMessageId: "message-id",
      text: "snap-runtime-gate-123",
    });
    expect(runtime.exportState).toHaveBeenCalledOnce();
    expect(state.encrypted).toMatchObject({ contentType: "chat" });

    await expect(runLiveCheck(state, "managed_chat_sent", dependencies))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });

  it("rejects missing managed-recipient configuration before encryption", async () => {
    const state = context();
    state.runtime = {
      initialize: async () => undefined,
      encryptChat: async () => ({ bytes: new Uint8Array(), contentType: "chat" }),
      exportState: async () => ({}),
      shutdown: async () => undefined,
    };
    await expect(runLiveCheck(state, "content_envelope_created", { env: {} }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
