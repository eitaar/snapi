import { describe, expect, it } from "vitest";
import { analyzeGatewayHar } from "../../scripts/analyze-gateway-har.mjs";

function base64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64");
}

describe("Gateway HAR analyzer", () => {
  it("summarizes the websocket handshake and safe frame descriptors without payloads", () => {
    const gatewayEnvelope = [
      0x0a, 0x03, 0x6d, 0x63, 0x73,
      0x12, 0x02, 0x0a, 0x00,
    ];
    const grpcFrame = [0x00, 0x00, 0x00, 0x00, gatewayEnvelope.length, ...gatewayEnvelope];
    const result = analyzeGatewayHar({
      log: {
        entries: [
          {
            startedDateTime: "2026-08-13T00:00:00.000Z",
            request: {
              method: "GET",
              url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
              headers: [
                { name: "Origin", value: "https://www.snapchat.com" },
                { name: "Sec-WebSocket-Protocol", value: "snap-ws-auth, redacted" },
              ],
            },
            response: {
              status: 101,
              headers: [{ name: "Sec-WebSocket-Protocol", value: "snap-ws-auth" }],
            },
            _webSocketMessages: [
              { type: "send", opcode: 2, data: base64(grpcFrame), time: 1 },
            ],
          },
        ],
      },
    });

    expect(result.gatewayHandshakes).toEqual([expect.objectContaining({
      status: 101,
      classification: "open",
      protocol: "snap-ws-auth",
      websocketMessageCount: 1,
      frameDescriptors: [{ direction: "send", opcode: 2, encodedLength: base64(grpcFrame).length, decodedLength: grpcFrame.length, grpcKinds: ["data"], gatewayPaths: ["mcs"] }],
    })]);
    expect(JSON.stringify(result)).not.toContain("redacted");
    expect(JSON.stringify(result)).not.toContain("messageContents");
  });

  it("keeps the relative order of gateway and messaging RPC paths", () => {
    const result = analyzeGatewayHar({
      log: {
        entries: [
          { request: { method: "GET", url: "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect" }, response: { status: 101 } },
          { request: { method: "POST", url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/SyncConversations" }, response: { status: 200 } },
          { request: { method: "POST", url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage" }, response: { status: 200 } },
        ],
      },
    });

    expect(result.pathSequence).toEqual([
      "GET /snapchat.gateway.Gateway/WebSocketConnect 101",
      "POST /messagingcoreservice.MessagingCoreService/SyncConversations 200",
      "POST /messagingcoreservice.MessagingCoreService/CreateContentMessage 200",
    ]);
  });
});
