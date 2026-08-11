import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_ASSETS } from "../../src/compat/guard.js";
import {
  beginOfficialCaptureOnly,
  drainOfficialCapturedRequests,
  drainOfficialObservedRequests,
} from "../../src/runtime/official-host-control.js";
import { OfficialWorkerClient } from "../../src/runtime/official-worker-client.js";
import type { SessionExport } from "../../src/session/types.js";

const enabled = process.env.SNAP_BUNDLE_ASSET_TESTS === "1";

describe("official Worker host diagnostics", () => {
  it("drains safe request observations through host control", async () => {
    const apply = vi.fn(async () => [{
      path: "https://web.snapchat.com/web-chat-session/refresh",
      method: "POST",
      responseStatus: 401,
    }]);
    const client = { apply } as unknown as OfficialWorkerClient;

    await expect(drainOfficialObservedRequests(client)).resolves.toEqual([{
      path: "https://web.snapchat.com/web-chat-session/refresh",
      method: "POST",
      responseStatus: 401,
    }]);
    expect(apply).toHaveBeenCalledWith(["__host", "drainObservedRequests"]);
  });
});

describe.skipIf(!enabled)("official Worker host capture control", () => {
  it("switches the real pinned-bundle host into capture-only mode", async () => {
    const session: SessionExport = {
      formatVersion: 1,
      accountId: "11111111-1111-4111-8111-111111111111",
      buildId: "8dd50222",
      exportedAt: "2026-08-11T00:00:00.000Z",
      auth: {
        httpToken: "offline-probe-token",
        gatewayToken: "offline-probe-token",
        cookieHeader: "offline-probe-cookie",
        requestHeaders: {},
      },
      assets: SUPPORTED_ASSETS,
      localStorage: {},
      sessionStorage: {},
      indexedDb: { databases: [] },
    };
    const client = new OfficialWorkerClient({
      assetDir: "private/assets",
      workerUrl: new URL("../../dist/runtime/official-worker-entry.js", import.meta.url),
    });
    try {
      await client.initializeWasm(session);
      await beginOfficialCaptureOnly(client);
      await expect(drainOfficialCapturedRequests(client)).resolves.toEqual([]);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }, 40_000);
});
