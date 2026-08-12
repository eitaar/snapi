import { describe, expect, it } from "vitest";
import { summarizeGatewayHandshake } from "../../src/gateway/handshake.js";

describe("Gateway handshake diagnostics", () => {
  it("classifies a successful upgrade without exposing protocol credentials", () => {
    const observation = summarizeGatewayHandshake(101, {
      "Sec-WebSocket-Protocol": "snap-ws-auth",
      Server: "edge",
    }, 12.4);

    expect(observation).toEqual({
      status: 101,
      classification: "open",
      protocol: "snap-ws-auth",
      headerNames: ["sec-websocket-protocol", "server"],
      durationMs: 12,
    });
  });

  it("classifies 401 and 403 as authorization rejection", () => {
    expect(summarizeGatewayHandshake(401, { "content-type": "text/plain" }, 4))
      .toMatchObject({ classification: "authorization-rejected", protocol: "none" });
    expect(summarizeGatewayHandshake(403, {}, 4))
      .toMatchObject({ classification: "authorization-rejected", protocol: "none" });
  });

  it("normalizes header names and never includes header values", () => {
    const observation = summarizeGatewayHandshake(429, {
      "X-Request-Id": "secret-request-id",
      "Sec-WebSocket-Protocol": "bearer-secret",
    }, 0);

    expect(observation).toMatchObject({
      classification: "rate-limited",
      protocol: "other",
      headerNames: ["sec-websocket-protocol", "x-request-id"],
    });
    expect(JSON.stringify(observation)).not.toContain("secret");
  });
});
