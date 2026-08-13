import { describe, expect, it } from "vitest";
import {
  compareAuthBindingHarTokens,
  summarizeAuthBindingHar,
} from "../../src/diagnostics/auth-binding-har.js";

const TOKEN_SENTINEL = "token-sentinel-" + "t".repeat(80);
const OTHER_TOKEN_SENTINEL = "other-token-" + "u".repeat(80);
const COOKIE_SENTINEL = "cookie-sentinel";
const HEADER_NAME_SENTINEL = "credential-header-sentinel";
const ARBITRARY_ORIGIN = "https://untrusted.example/opaque-origin";
const ARBITRARY_TIMESTAMP = "timestamp-sentinel";

function miniHar(overrides: {
  readonly includeGateway?: boolean;
  readonly includeMessaging?: boolean;
  readonly includeWrite?: boolean;
  readonly includeVersionMarker?: boolean;
  readonly gatewayAuthorization?: string;
  readonly gatewayToken?: string;
  readonly gatewayOrigin?: string;
  readonly gatewayResponseProtocol?: string;
  readonly gatewayStartedAt?: string;
  readonly messagingStartedAt?: string;
  readonly versionMarker?: string;
  readonly versionMarkerOrigin?: string;
  readonly messagingHttpVersion?: string;
  readonly messagingPostData?: Record<string, string>;
} = {}): object {
  const messagingToken = TOKEN_SENTINEL;
  const gatewayToken = overrides.gatewayToken ?? messagingToken;
  return {
    log: {
      creator: { version: "untrusted-exporter-version" },
      entries: [
        ...(overrides.includeVersionMarker === false ? [] : [{
          request: {
            method: "GET",
            url: `${overrides.versionMarkerOrigin ?? "https://web.snapchat.com"}/web/version.json?version=${overrides.versionMarker ?? "8dd50222"}`,
            headers: [{ name: ":path", value: "/web/version.json?version=8dd50222" }],
          },
          response: { status: 200, headers: [] },
        }]),
        {
          startedDateTime: "2026-08-13T01:00:00.000Z",
          request: {
            method: "POST",
            url: "https://accounts.snapchat.com/accounts/sso",
            headers: [
              { name: "Cookie", value: COOKIE_SENTINEL },
              { name: "Origin", value: "https://www.snapchat.com" },
            ],
          },
          response: { status: 200, headers: [] },
        },
        ...(overrides.includeGateway === false ? [] : [{
          startedDateTime: overrides.gatewayStartedAt ?? "2026-08-13T01:00:01.000Z",
          request: {
            method: "GET",
            url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
            headers: [
              { name: "Sec-WebSocket-Protocol", value: `snap-ws-auth, ${gatewayToken}` },
              { name: "Origin", value: overrides.gatewayOrigin ?? "https://www.snapchat.com" },
              ...(overrides.gatewayAuthorization === undefined
                ? []
                : [{ name: "Authorization", value: overrides.gatewayAuthorization }]),
            ],
          },
          response: {
            status: 101,
            headers: overrides.gatewayResponseProtocol === ""
              ? []
              : [{ name: "Sec-WebSocket-Protocol", value: overrides.gatewayResponseProtocol ?? "snap-ws-auth" }],
          },
        }]),
        ...(overrides.includeMessaging === false ? [] : [{
          startedDateTime: overrides.messagingStartedAt ?? "2026-08-13T01:00:02.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
            httpVersion: overrides.messagingHttpVersion,
            headers: [
              { name: "Authorization", value: `Bearer ${messagingToken}` },
              { name: "Content-Type", value: "application/grpc-web+proto" },
              { name: HEADER_NAME_SENTINEL, value: "do-not-return-header-name" },
            ],
            postData: overrides.messagingPostData ?? { text: "safe request bytes" },
          },
          response: { status: 200, headers: [] },
        }]),
        ...(overrides.includeWrite === false ? [] : [{
          startedDateTime: "2026-08-13T01:00:03.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
            headers: [{ name: "Authorization", value: `Bearer ${messagingToken}` }],
          },
          response: { status: 200, headers: [] },
        }]),
      ],
    },
  };
}

function expectInvalidWithoutSecrets(input: object): void {
  try {
    summarizeAuthBindingHar(JSON.stringify(input));
    throw new Error("expected invalid HAR");
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_SESSION_EXPORT" });
    expect(JSON.stringify(error)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(error)).not.toContain(OTHER_TOKEN_SENTINEL);
  }
}

describe("summarizeAuthBindingHar", () => {
  it("compares Browser baseline tokens in memory and returns booleans only", () => {
    const matching = compareAuthBindingHarTokens(JSON.stringify(miniHar()), {
      httpToken: TOKEN_SENTINEL,
      gatewayToken: TOKEN_SENTINEL,
    });
    const stale = compareAuthBindingHarTokens(JSON.stringify(miniHar()), {
      httpToken: OTHER_TOKEN_SENTINEL,
      gatewayToken: OTHER_TOKEN_SENTINEL,
    });

    expect(matching).toEqual({ messaging: true, gateway: true });
    expect(stale).toEqual({ messaging: false, gateway: false });
    expect(JSON.stringify({ matching, stale })).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify({ matching, stale })).not.toContain(OTHER_TOKEN_SENTINEL);
  });

  it("summarizes successful Gateway and read-only Messaging metadata without credentials", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar()));

    expect(summary).toMatchObject({
      buildId: "8dd50222",
      gateway101Count: 1,
      messagingSuccessCount: 1,
      messagingWriteCount: 1,
      gatewayMessagingTokenEqual: true,
      gatewayOrigin: "https://www.snapchat.com",
      gatewayHasCookie: false,
      gatewayProtocols: ["snap-ws-auth"],
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(summary)).not.toContain(COOKIE_SENTINEL);
    expect(JSON.stringify(summary)).not.toContain(HEADER_NAME_SENTINEL);
  });

  it("accepts a pinned build marker from the official www origin", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      versionMarkerOrigin: "https://www.snapchat.com",
    })));

    expect(summary.buildId).toBe("8dd50222");
  });

  it.each([
    ["missing", ""],
    ["different", "other-protocol"],
    ["offered-list", "snap-ws-auth, another-protocol"],
  ])("rejects a Gateway 101 with a %s selected response protocol", (_reason, gatewayResponseProtocol) => {
    expectInvalidWithoutSecrets(miniHar({ gatewayResponseProtocol }));
  });

  it.each([
    ["Gateway 101 is missing", miniHar({ includeGateway: false })],
    ["Messaging 200 is missing", miniHar({ includeMessaging: false, includeWrite: false })],
    ["capture is write-only", miniHar({ includeMessaging: false })],
    ["Gateway and Messaging tokens differ", miniHar({ gatewayToken: OTHER_TOKEN_SENTINEL })],
    ["pinned version marker is missing", miniHar({ includeVersionMarker: false })],
    ["pinned version marker is wrong", miniHar({ versionMarker: "wrong-build" })],
  ])("rejects when %s without exposing compared credentials", (_reason, input) => {
    expectInvalidWithoutSecrets(input);
  });

  it("hashes plain-text Messaging post data as UTF-8 bytes", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      messagingPostData: { text: "plain-body" },
    })));

    expect(summary).toMatchObject({
      messagingBodyBytes: 10,
      messagingBodySha256: "5c7f9d653861bf39bcf7c1241663b1b5c24a79cfeb22c9727d3ff04384299b34",
    });
  });

  it("decodes base64 Messaging post data before summarizing body bytes", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      messagingPostData: { text: "AP8Q", encoding: "base64" },
    })));

    expect(summary).toMatchObject({
      messagingBodyBytes: 3,
      messagingBodySha256: "2da45f2cd1f9c8e69a67abf7a6b26c282533d0a7686787a9533265418680d4d2",
    });
  });

  it("omits body metadata for an unsupported post-data encoding", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      messagingPostData: { text: "686578", encoding: "hex" },
    })));

    expect(summary).not.toHaveProperty("messagingBodyBytes");
    expect(summary).not.toHaveProperty("messagingBodySha256");
  });

  it("normalizes HAR HTTP versions before returning safe protocols", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      messagingHttpVersion: "HTTP/2.0",
    })));

    expect(summary.messagingProtocols).toEqual(["h2"]);
  });

  it("detects a Gateway Authorization header without returning its value or name", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      gatewayAuthorization: `Bearer ${TOKEN_SENTINEL}`,
    })));

    expect(summary.gatewayHasAuthorization).toBe(true);
    expect(summary.gatewayRequestHeaderNames).not.toContain("authorization");
    expect(JSON.stringify(summary)).not.toContain(TOKEN_SENTINEL);
  });

  it("omits arbitrary Gateway origin and timestamp values", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      gatewayOrigin: ARBITRARY_ORIGIN,
      gatewayStartedAt: ARBITRARY_TIMESTAMP,
      messagingStartedAt: ARBITRARY_TIMESTAMP,
    })));

    expect(summary).not.toHaveProperty("gatewayOrigin");
    expect(summary).not.toHaveProperty("gatewayStartedAt");
    expect(summary).not.toHaveProperty("messagingStartedAt");
    expect(JSON.stringify(summary)).not.toContain(ARBITRARY_ORIGIN);
    expect(JSON.stringify(summary)).not.toContain(ARBITRARY_TIMESTAMP);
  });

  it("canonicalizes strict UTC timestamps before returning them", () => {
    const summary = summarizeAuthBindingHar(JSON.stringify(miniHar({
      gatewayStartedAt: "2026-08-13T01:00:01Z",
      messagingStartedAt: "2026-08-13T01:00:02.5Z",
    })));

    expect(summary).toMatchObject({
      gatewayStartedAt: "2026-08-13T01:00:01.000Z",
      messagingStartedAt: "2026-08-13T01:00:02.500Z",
    });
  });
});
