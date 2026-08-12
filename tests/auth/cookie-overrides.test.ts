import { describe, expect, it } from "vitest";
import { applyCookieOverrides } from "../../src/auth/cookie-overrides.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: {
      httpToken: "http-token",
      gatewayToken: "gateway-token",
      cookieHeader: "web=old",
      ssoCookieHeader: "sso=old",
      ssoScuid: "scuid",
      requestHeaders: { "x-user-agent": "ua" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("applyCookieOverrides", () => {
  it("overrides Web and SSO cookies without changing other session state", () => {
    const updated = applyCookieOverrides(session(), {
      cookieHeader: "web=new",
      ssoCookieHeader: "sso=new",
    });

    expect(updated.auth.cookieHeader).toBe("web=new");
    expect(updated.auth.ssoCookieHeader).toBe("sso=new");
    expect(updated.auth.httpToken).toBe("http-token");
    expect(updated.auth.requestHeaders).toEqual({ "x-user-agent": "ua" });
  });

  it("leaves the session unchanged when no override is configured", () => {
    const original = session();
    expect(applyCookieOverrides(original, {})).toEqual(original);
  });
});
