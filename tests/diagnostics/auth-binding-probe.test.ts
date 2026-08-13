import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runNodeAuthBindingProbe, type NodeAuthBindingProbeInput } from "../../src/diagnostics/auth-binding-probe.js";

const tokenSentinel = "http-token-sentinel";
const cookieSentinel = "web-cookie-sentinel";
const gatewayTokenSentinel = "gateway-token-sentinel";
const bodySentinel = "response-body-sentinel";

const messagingInput = (
  context: "node-http1" | "node-http2",
  request: Partial<NonNullable<NodeAuthBindingProbeInput["request"]>> = {},
): NodeAuthBindingProbeInput => ({
  authEpoch: "epoch-a",
  context,
  request: {
    url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
    method: "POST",
    headers: { accept: "application/grpc-web+proto", "content-type": "application/grpc-web+proto" },
    bodyBase64: Buffer.from([1, 2, 3]).toString("base64"),
    ...request,
  },
  auth: { httpToken: tokenSentinel, cookieHeader: cookieSentinel },
});

const gatewayInput = (gatewayToken = gatewayTokenSentinel): NodeAuthBindingProbeInput => ({
  authEpoch: "epoch-a",
  context: "node-gateway",
  auth: { httpToken: tokenSentinel, cookieHeader: cookieSentinel, gatewayToken },
});

describe("runNodeAuthBindingProbe", () => {
  it("maps one HTTP/1 read-only 401 without retaining credentials", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));

    const observation = await runNodeAuthBindingProbe(messagingInput("node-http1"), {
      fetch,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });

    expect(observation).toMatchObject({
      context: "node-http1",
      operation: "messaging-read",
      status: 401,
      protocol: "http/1.1",
      tokenEqualsEpochBaseline: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(observation)).not.toContain(tokenSentinel);
    expect(JSON.stringify(observation)).not.toContain(cookieSentinel);
  });

  it("sends one HTTP/2 POST and closes the session without retaining a response body", async () => {
    const stream = new EventEmitter() as EventEmitter & { end: () => void; close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn> };
    stream.close = vi.fn();
    stream.destroy = vi.fn();
    stream.setTimeout = vi.fn();
    stream.end = () => {
      stream.emit("response", { ":status": 401, "x-secret-body": bodySentinel });
      stream.emit("data", bodySentinel);
      stream.emit("end");
    };
    const session = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    session.request = vi.fn(() => stream);
    session.close = vi.fn();
    session.destroy = vi.fn();
    const http2Connect = vi.fn(() => session);

    const observation = await runNodeAuthBindingProbe(messagingInput("node-http2"), {
      http2Connect: http2Connect as never,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });

    expect(http2Connect).toHaveBeenCalledTimes(1);
    expect(http2Connect).toHaveBeenCalledWith("https://web.snapchat.com");
    expect(session.request).toHaveBeenCalledOnce();
    expect(session.request).toHaveBeenCalledWith(expect.objectContaining({
      ":authority": "web.snapchat.com",
      ":method": "POST",
      ":path": "/messagingcoreservice.MessagingCoreService/DeltaSync",
    }));
    expect(observation).toMatchObject({ context: "node-http2", status: 401, protocol: "h2" });
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(observation)).not.toContain(bodySentinel);
  });

  it("maps one successful gateway handshake without retaining gateway metadata", async () => {
    const gatewayProbe = vi.fn(async () => ({
      status: 101,
      classification: "open" as const,
      protocol: "snap-ws-auth" as const,
      headerNames: ["set-cookie"],
      durationMs: 3,
    }));

    const observation = await runNodeAuthBindingProbe(gatewayInput(), { gatewayProbe });

    expect(observation).toMatchObject({
      context: "node-gateway",
      operation: "gateway-handshake",
      status: 101,
      protocol: "websocket",
    });
    expect(gatewayProbe).toHaveBeenCalledOnce();
    expect(JSON.stringify(observation)).not.toContain("set-cookie");
    expect(JSON.stringify(observation)).not.toContain(gatewayTokenSentinel);
  });

  it("maps one rejected gateway handshake", async () => {
    const gatewayProbe = vi.fn(async () => ({
      status: 401,
      classification: "authorization-rejected" as const,
      protocol: "none" as const,
      headerNames: [],
      durationMs: 3,
    }));

    await expect(runNodeAuthBindingProbe(gatewayInput(), { gatewayProbe }))
      .resolves.toMatchObject({ status: 401, protocol: "websocket" });
    expect(gatewayProbe).toHaveBeenCalledOnce();
  });

  it("rejects invalid input without echoing credentials", async () => {
    const fetch = vi.fn();
    const invalidRequest = messagingInput("node-http1", { url: "https://web.snapchat.com/not-allowlisted" });

    const invalidRequestError = await runNodeAuthBindingProbe(invalidRequest, { fetch }).catch((error: unknown) => error);
    const missingTokenError = await runNodeAuthBindingProbe(gatewayInput(""))
      .catch((error: unknown) => error);

    expect(invalidRequestError).toMatchObject({ code: "INVALID_CONFIG" });
    expect(missingTokenError).toMatchObject({ code: "INVALID_SESSION_EXPORT" });
    expect(JSON.stringify(invalidRequestError)).not.toContain(tokenSentinel);
    expect(JSON.stringify(missingTokenError)).not.toContain(gatewayTokenSentinel);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps an HTTP/2 timeout once and destroys all resources without retrying", async () => {
    const stream = new EventEmitter() as EventEmitter & { end: () => void; close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn> };
    stream.close = vi.fn();
    stream.destroy = vi.fn();
    stream.setTimeout = vi.fn((_: number, callback: () => void) => callback());
    stream.end = vi.fn();
    const session = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    session.request = vi.fn(() => stream);
    session.close = vi.fn();
    session.destroy = vi.fn();
    const http2Connect = vi.fn(() => session);

    const observation = await runNodeAuthBindingProbe(messagingInput("node-http2"), {
      http2Connect: http2Connect as never,
    });

    expect(observation).toMatchObject({ context: "node-http2", transportError: "timeout" });
    expect(http2Connect).toHaveBeenCalledOnce();
    expect(session.request).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
  });
});
