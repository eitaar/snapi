import { describe, expect, it, vi } from "vitest";
import {
  refreshSnapchatSession,
  refreshSnapchatSso,
  refreshSnapchatWebSession,
} from "../../src/transport/sso-auth-refresh.js";
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
      cookieHeader: "web=old; retained=value",
      ssoCookieHeader: "account=old",
      ssoScuid: "1",
      ssoRequestHeaders: { "user-agent": "fallback browser" },
      webSessionRequestHeaders: {
        origin: "https://www.snapchat.com",
        referer: "https://www.snapchat.com/",
        "sec-ch-ua-platform": "\"Windows\"",
        "user-agent": "captured browser",
        "x-snap-client-user-agent": "SnapchatWeb/test",
      },
      requestHeaders: { "mcs-cof-ids-bin": "cof" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("refreshSnapchatSso", () => {
  it("runs the browser Web-session heartbeat without replacing bearer tokens", async () => {
    const responseHeaders = new Headers();
    responseHeaders.append("set-cookie", "web=rotated; Path=/; Secure; HttpOnly");
    responseHeaders.append("set-cookie", "added=value; Path=/");
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 200, headers: responseHeaders }));

    const refreshed = await refreshSnapchatWebSession(session(), {
      fetch,
      now: () => new Date("2026-08-11T01:02:03.000Z"),
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://web.snapchat.com/web-chat-session/refresh?client_id=web-calling-corp--prod",
    );
    expect(init).toMatchObject({ method: "POST", body: null, redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer old-http-token");
    expect(headers.get("cookie")).toBe("web=old; retained=value");
    expect(headers.get("origin")).toBe("https://www.snapchat.com");
    expect(headers.get("referer")).toBe("https://www.snapchat.com/");
    expect(headers.get("user-agent")).toBe("captured browser");
    expect(headers.get("x-snap-client-user-agent")).toBe("SnapchatWeb/test");
    expect(headers.has("scuid")).toBe(false);
    expect(headers.has("snap-att")).toBe(false);
    expect(refreshed).toMatchObject({
      exportedAt: "2026-08-11T01:02:03.000Z",
      auth: {
        httpToken: "old-http-token",
        gatewayToken: "old-gateway-token",
        cookieHeader: "web=rotated; retained=value; added=value",
        ssoCookieHeader: "account=old",
      },
    });
  });

  it("uses safe browser defaults for an older export", async () => {
    const value = session() as SessionExport & {
      auth: { webSessionRequestHeaders?: Readonly<Record<string, string>> };
    };
    delete value.auth.webSessionRequestHeaders;
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 200 }));

    await refreshSnapchatWebSession(value, { fetch });

    const [, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("origin")).toBe("https://www.snapchat.com");
    expect(headers.get("referer")).toBe("https://www.snapchat.com/");
    expect(headers.get("user-agent")).toBe("fallback browser");
  });

  it("classifies redirects and authorization failures as an expired export", async () => {
    for (const [status, location] of [[303, "/v2/login?code=secret"], [403, undefined]] as const) {
      const fetch = vi.fn(async () => new Response(null, {
        status,
        ...(location === undefined ? {} : { headers: { location } }),
      }));

      await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.toMatchObject({
        code: "SESSION_REEXPORT_REQUIRED",
        details: { status },
      });
      await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.not.toThrow("secret");
    }
  });

  it("rejects other HTTP failures without exposing response data", async () => {
    const fetch = vi.fn(async () => new Response("response-secret", { status: 500 }));

    await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      details: { status: 500 },
    });
    await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.not.toThrow("response-secret");
  });

  it("wraps network failures without exposing their message", async () => {
    const fetch = vi.fn(async () => { throw new Error("network-secret"); });

    await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      message: "Unable to refresh the exported Web session",
      details: { errorName: "Error" },
    });
    await expect(refreshSnapchatWebSession(session(), { fetch })).rejects.not.toThrow("network-secret");
  });

  it("renews the shared HTTP and Gateway token", async () => {
    const token = "n".repeat(292);
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(token, { status: 200, headers: { scuid: session().accountId } }));
    const attestation = vi.fn(async () => "attestation-proof");

    const refreshed = await refreshSnapchatSso(session(), {
      fetch,
      attestation,
      now: () => new Date("2026-08-11T01:02:03.000Z"),
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("snap-att")).toBe("attestation-proof");
    expect(headers.get("cookie")).toBe("account=old");
    expect(headers.has("scuid")).toBe(false);
    expect(refreshed.auth.httpToken).toBe(token);
    expect(refreshed.auth.gatewayToken).toBe(token);
    expect(refreshed.auth.tokenRefreshedAt).toBe("2026-08-11T01:02:03.000Z");
  });

  it("runs SSO renewal and a due Web heartbeat as one CLI refresh", async () => {
    const token = "r".repeat(292);
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      if (url.includes("accounts.snapchat.com")) return new Response(token, { status: 200 });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return new Response(null, { status: 200 });
    });

    const refreshed = await refreshSnapchatSession(session(), {
      fetch,
      now: () => new Date("2026-08-11T02:00:00.000Z"),
    });

    expect(calls).toEqual(["/accounts/sso", "/web-chat-session/refresh"]);
    expect(refreshed.auth.httpToken).toBe(token);
    expect(refreshed.auth.webSessionRefreshedAt).toBe("2026-08-11T02:00:00.000Z");
  });
});
