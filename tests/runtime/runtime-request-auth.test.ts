import { describe, expect, it } from "vitest";
import { RuntimeRequestAuth } from "../../src/runtime/runtime-request-auth.js";
import type { RuntimeAuthUpdate } from "../../src/runtime/protocol.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account",
    buildId: "8dd50222",
    exportedAt: "2026-08-12T00:00:00.000Z",
    auth: {
      httpToken: "initial-http-token",
      gatewayToken: "initial-gateway-token",
      cookieHeader: "initial-cookie",
      requestHeaders: { "mcs-cof-ids-bin": "initial-cof" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("RuntimeRequestAuth", () => {
  it("serves updated in-memory credentials to photo-upload gRPC calls", async () => {
    const auth = new RuntimeRequestAuth(session());
    const update: RuntimeAuthUpdate = {
      accountId: "account",
      httpToken: "updated-http-token",
      gatewayToken: "updated-gateway-token",
      cookieHeader: "updated-cookie",
      ssoCookieHeader: "updated-sso-cookie",
      mcsCofSequenceIds: "updated-cof",
    };

    auth.update(update);

    await expect(auth.getRequestAuth()).resolves.toEqual({
      httpToken: "updated-http-token",
      cookieHeader: "updated-cookie",
      headers: { "mcs-cof-ids-bin": "updated-cof" },
    });
  });
});
