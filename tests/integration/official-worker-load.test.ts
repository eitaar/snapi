import { describe, expect, it } from "vitest";
import { SUPPORTED_ASSETS } from "../../src/compat/guard.js";
import { ContentRuntimeClient } from "../../src/runtime/worker-client.js";
import type { SessionExport } from "../../src/session/types.js";

const enabled = process.env.SNAP_BUNDLE_ASSET_TESTS === "1";

describe.skipIf(!enabled)("official messaging Worker assets", () => {
  it("loads the observed Emscripten WASM through the official glue", async () => {
    const session: SessionExport = {
      formatVersion: 1,
      accountId: "offline-probe-account",
      buildId: "8dd50222",
      exportedAt: "2026-08-10T00:00:00.000Z",
      auth: {
        httpToken: "offline-probe-token",
        gatewayToken: "offline-probe-token",
        cookieHeader: "offline-probe-cookie",
        requestHeaders: {},
      },
      assets: SUPPORTED_ASSETS,
      localStorage: {},
      indexedDb: { databases: [] },
    };
    const runtime = new ContentRuntimeClient({ workerUrl: new URL("../../dist/runtime/worker-entry.js", import.meta.url), assetDir: "private/assets", timeoutMs: 30_000 });

    try {
      await expect(runtime.initialize(session)).resolves.toMatchObject({ buildId: "8dd50222" });
      await expect(runtime.encryptChat({
        recipientId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        clientMessageId: "44444444-4444-4444-8444-444444444444",
        text: "offline probe",
      })).rejects.toMatchObject({
        code: "SESSION_REEXPORT_REQUIRED",
      });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 40_000);
});
