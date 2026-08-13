import { describe, expect, it } from "vitest";
import { summarizeAuthBindingHar } from "../../src/diagnostics/auth-binding-har.js";

const TOKEN_SENTINEL = "token-sentinel-" + "t".repeat(80);
const OTHER_TOKEN_SENTINEL = "other-token-" + "u".repeat(80);
const COOKIE_SENTINEL = "cookie-sentinel";

function miniHar(overrides: {
  readonly includeGateway?: boolean;
  readonly includeMessaging?: boolean;
  readonly includeWrite?: boolean;
  readonly gatewayToken?: string;
} = {}): object {
  const messagingToken = TOKEN_SENTINEL;
  const gatewayToken = overrides.gatewayToken ?? messagingToken;
  return {
    log: {
      creator: { version: "8dd50222" },
      entries: [
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
          startedDateTime: "2026-08-13T01:00:01.000Z",
          request: {
            method: "GET",
            url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
            headers: [
              { name: "Sec-WebSocket-Protocol", value: `snap-ws-auth, ${gatewayToken}` },
              { name: "Origin", value: "https://www.snapchat.com" },
            ],
          },
          response: { status: 101, headers: [{ name: "Sec-WebSocket-Protocol", value: "snap-ws-auth" }] },
        }]),
        ...(overrides.includeMessaging === false ? [] : [{
          startedDateTime: "2026-08-13T01:00:02.000Z",
          request: {
            method: "POST",
            url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
            headers: [
              { name: "Authorization", value: `Bearer ${messagingToken}` },
              { name: "Content-Type", value: "application/grpc-web+proto" },
            ],
            postData: { text: "safe request bytes" },
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
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(summary)).not.toContain(COOKIE_SENTINEL);
  });

  it.each([
    ["Gateway 101 is missing", miniHar({ includeGateway: false })],
    ["Messaging 200 is missing", miniHar({ includeMessaging: false, includeWrite: false })],
    ["capture is write-only", miniHar({ includeMessaging: false })],
    ["Gateway and Messaging tokens differ", miniHar({ gatewayToken: OTHER_TOKEN_SENTINEL })],
  ])("rejects when %s without exposing compared credentials", (_reason, input) => {
    expectInvalidWithoutSecrets(input);
  });
});
