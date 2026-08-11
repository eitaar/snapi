import { describe, expect, it } from "vitest";
import { enrichSessionWithHarSso } from "../../src/session/har-auth.js";
import type { SessionExport } from "../../src/session/types.js";

const session: SessionExport = {
  formatVersion: 1,
  accountId: "11111111-2222-3333-4444-555555555555",
  buildId: "8dd50222",
  exportedAt: "2026-08-11T00:00:00.000Z",
  auth: { httpToken: "h", gatewayToken: "g", cookieHeader: "web=1", requestHeaders: {} },
  assets: [],
  localStorage: {},
  indexedDb: { databases: [] },
};

function har(cookie = "account-session=secret", scuid = session.accountId): unknown {
  return {
    log: {
      entries: [{
        startedDateTime: "2026-08-11T00:01:00.000Z",
        request: {
          method: "POST",
          url: "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod",
          headers: [{ name: "Cookie", value: cookie }, { name: "scuid", value: scuid }],
        },
        response: { headers: [{ name: "scuid", value: session.accountId }] },
      }],
    },
  };
}

describe("enrichSessionWithHarSso", () => {
  it("imports only the accounts-domain SSO cookie into auth state", () => {
    expect(enrichSessionWithHarSso(session, har())).toMatchObject({
      auth: {
        cookieHeader: "web=1",
        ssoCookieHeader: "account-session=secret",
        ssoScuid: session.accountId,
      },
    });
  });

  it("rejects missing evidence and account mismatches without exposing cookie values", () => {
    expect(() => enrichSessionWithHarSso(session, { log: { entries: [] } }))
      .toThrow("SSO request");
    try {
      const value = har("do-not-leak", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") as {
        log: { entries: Array<{ response: { headers: Array<{ name: string; value: string }> } }> };
      };
      value.log.entries[0]!.response.headers[0]!.value = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      enrichSessionWithHarSso(session, value);
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_SESSION_EXPORT" });
      expect(JSON.stringify(error)).not.toContain("do-not-leak");
    }
  });
});
