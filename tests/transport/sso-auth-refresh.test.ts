import { describe, expect, it, vi } from "vitest";
import { refreshSnapchatSso } from "../../src/transport/sso-auth-refresh.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "11111111-2222-3333-4444-555555555555",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: {
      httpToken: "old-http-token",
      gatewayToken: "old-gateway-token",
      cookieHeader: "web=only",
      ssoCookieHeader: "first=one; session=old",
      ssoScuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      requestHeaders: { "mcs-cof-ids-bin": "cof" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("refreshSnapchatSso", () => {
  it("refreshes both bearer tokens and merges rotated cookies", async () => {
    const token = "a".repeat(292);
    const headers = new Headers({ scuid: session().accountId });
    headers.append("set-cookie", "session=new; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", "added=value; Path=/");
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(token, { status: 200, headers }));

    const refreshed = await refreshSnapchatSso(session(), {
      fetch,
      now: () => new Date("2026-08-11T01:02:03.000Z"),
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod");
    expect(init).toMatchObject({ method: "POST", body: null });
    expect(new Headers(init?.headers).get("cookie")).toBe("first=one; session=old");
    expect(new Headers(init?.headers).get("scuid")).toBe(session().auth.ssoScuid);
    expect(refreshed).toMatchObject({
      exportedAt: "2026-08-11T01:02:03.000Z",
      auth: {
        httpToken: token,
        gatewayToken: token,
        cookieHeader: "web=only",
        ssoCookieHeader: "first=one; session=new; added=value",
        requestHeaders: { "mcs-cof-ids-bin": "cof" },
      },
    });
  });

  it("rejects an account mismatch without exposing the token", async () => {
    const token = "b".repeat(292);
    const fetch = vi.fn(async () => new Response(token, {
      status: 200,
      headers: { scuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    }));

    await expect(refreshSnapchatSso(session(), { fetch })).rejects.toMatchObject({
      code: "INVALID_SESSION_EXPORT",
      message: "SSO refresh account does not match the session export",
    });
    await expect(refreshSnapchatSso(session(), { fetch })).rejects.not.toThrow(token);
  });

  it("turns an unauthorized refresh into a safe re-export error", async () => {
    const fetch = vi.fn(async () => new Response("denied-secret", { status: 401 }));

    await expect(refreshSnapchatSso(session(), { fetch })).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      details: { status: 401 },
    });
  });

  it("rejects a malformed successful response", async () => {
    const fetch = vi.fn(async () => new Response("too-short", {
      status: 200,
      headers: { scuid: session().accountId },
    }));

    await expect(refreshSnapchatSso(session(), { fetch })).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      message: "SSO refresh returned an invalid token",
    });
  });

  it("fails before network access when the SSO-domain cookie export is absent", async () => {
    const value = session() as SessionExport & { auth: { ssoCookieHeader?: string } };
    delete value.auth.ssoCookieHeader;
    const fetch = vi.fn();

    await expect(refreshSnapchatSso(value, { fetch })).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      message: "Session export is missing the accounts-domain SSO cookie",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
