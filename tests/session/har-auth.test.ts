import { describe, expect, it } from "vitest";
import { enrichSessionWithHarAuth } from "../../src/session/har-auth.js";
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
  const token = "t".repeat(96);
  return {
    log: {
      entries: [
        {
          startedDateTime: "2026-08-11T00:01:00.000Z",
          request: {
            method: "POST",
            url: "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod",
            headers: [
              { name: "Cookie", value: cookie },
              { name: "scuid", value: scuid },
              { name: "Origin", value: "https://www.snapchat.com" },
              { name: "Referer", value: "https://www.snapchat.com/web" },
              { name: "User-Agent", value: "Mozilla/5.0 test browser" },
              { name: "Sec-CH-UA", value: "\"Chromium\";v=\"140\"" },
              { name: "Sec-CH-UA-Mobile", value: "?0" },
              { name: "Sec-CH-UA-Platform", value: "\"Windows\"" },
              { name: "Sec-Fetch-Site", value: "same-site" },
            ],
          },
          response: {
            status: 200,
            headers: [
              { name: "scuid", value: session.accountId },
              { name: "Set-Cookie", value: "account-session=rotated; Path=/; Secure" },
            ],
          },
        },
        {
          startedDateTime: "2026-08-11T00:01:01.000Z",
          request: {
            method: "GET",
            url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
            headers: [{ name: "Sec-WebSocket-Protocol", value: `snap-ws-auth, ${token}` }],
          },
          response: { status: 101, headers: [] },
        },
        {
          startedDateTime: "2026-08-11T00:01:02.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups",
            headers: [
              { name: "Authorization", value: `Bearer ${token}` },
              { name: "mcs-cof-ids-bin", value: "fresh-cof" },
              { name: "x-grpc-web", value: "1" },
              { name: "x-snap-client-user-agent", value: "grpc-web-javascript/0.1" },
              { name: "x-user-agent", value: "bitmoji-web" },
            ],
          },
          response: { status: 200, headers: [] },
        },
        {
          startedDateTime: "2026-08-11T00:01:03.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/com.snapchat.deltaforce.external.DeltaForce/DeltaSync",
            headers: [
              { name: "Authorization", value: `Bearer ${token}` },
              { name: "Cookie", value: "web=fresh" },
            ],
          },
          response: { status: 200, headers: [] },
        },
        {
          startedDateTime: "2026-08-11T00:01:04.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/web-chat-session/refresh?client_id=web-calling-corp--prod",
            headers: [
              { name: "Authorization", value: `Bearer ${token}` },
              { name: "Cookie", value: "web=fresh" },
              { name: "Origin", value: "https://www.snapchat.com" },
              { name: "Referer", value: "https://www.snapchat.com/" },
              { name: "User-Agent", value: "Mozilla/5.0 heartbeat browser" },
              { name: "X-Snap-Client-User-Agent", value: "SnapchatWeb/test" },
            ],
          },
          response: { status: 200, headers: [] },
        },
      ],
    },
  };
}

describe("enrichSessionWithHarAuth", () => {
  it("imports authentication proven by successful messaging requests", () => {
    expect(enrichSessionWithHarAuth(session, har())).toMatchObject({
      exportedAt: "2026-08-11T00:01:04.000Z",
      auth: {
        httpToken: "t".repeat(96),
        gatewayToken: "t".repeat(96),
        tokenRefreshedAt: "2026-08-11T00:01:02.000Z",
        webSessionRefreshedAt: "2026-08-11T00:01:04.000Z",
        cookieHeader: "web=fresh",
        ssoCookieHeader: "account-session=rotated",
        ssoScuid: session.accountId,
        ssoUsesDbsc: false,
        ssoUsesAttestation: false,
        ssoRequestHeaders: {
          origin: "https://www.snapchat.com",
          referer: "https://www.snapchat.com/web",
          "sec-ch-ua": "\"Chromium\";v=\"140\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "sec-fetch-site": "same-site",
          "user-agent": "Mozilla/5.0 test browser",
        },
        webSessionRequestHeaders: {
          origin: "https://www.snapchat.com",
          referer: "https://www.snapchat.com/",
          "user-agent": "Mozilla/5.0 heartbeat browser",
          "x-snap-client-user-agent": "SnapchatWeb/test",
        },
        requestHeaders: {
          "mcs-cof-ids-bin": "fresh-cof",
          "x-grpc-web": "1",
          "x-snap-client-user-agent": "grpc-web-javascript/0.1",
          "x-user-agent": "bitmoji-web",
        },
      },
    });
  });

  it("preserves the successful SSO request scuid for future requests", () => {
    const refreshed = enrichSessionWithHarAuth(session, har("account-session=secret", "1"));

    expect(refreshed.auth.ssoScuid).toBe("1");
  });

  it("rejects missing evidence and account mismatches without exposing cookie values", () => {
    expect(() => enrichSessionWithHarAuth(session, { log: { entries: [] } }))
      .toThrow("SSO request");
    try {
      const value = har("do-not-leak", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") as {
        log: { entries: Array<{ response: { headers: Array<{ name: string; value: string }> } }> };
      };
      value.log.entries[0]!.response.headers[0]!.value = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      enrichSessionWithHarAuth(session, value);
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_SESSION_EXPORT" });
      expect(JSON.stringify(error)).not.toContain("do-not-leak");
    }
  });

  it("rejects a gateway token that does not match successful Messaging API auth", () => {
    const value = har() as {
      log: { entries: Array<{ request: { headers: Array<{ name: string; value: string }> } }> };
    };
    value.log.entries[1]!.request.headers[0]!.value = `snap-ws-auth, ${"x".repeat(96)}`;
    expect(() => enrichSessionWithHarAuth(session, value)).toThrow("gateway authentication");
  });
});
