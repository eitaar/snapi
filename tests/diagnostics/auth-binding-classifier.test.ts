import { describe, expect, it } from "vitest";
import { classifyAuthBinding } from "../../src/diagnostics/auth-binding-classifier.js";
import type { SafeAuthBindingObservation } from "../../src/diagnostics/auth-binding-types.js";

const observation = (
  context: SafeAuthBindingObservation["context"],
  status: number | undefined,
  overrides: Partial<SafeAuthBindingObservation> = {},
): SafeAuthBindingObservation => ({
  authEpoch: "epoch-a",
  context,
  operation: context.includes("gateway") ? "gateway-handshake" : "messaging-read",
  endpointPath: context.includes("gateway")
    ? "/snapchat.gateway.Gateway/WebSocketConnect"
    : "/messagingcoreservice.MessagingCoreService/DeltaSync",
  startedAt: "2026-08-13T13:37:56.814Z",
  ...(status === undefined ? {} : { status }),
  requestBodyBytes: 65,
  requestBodySha256: "a".repeat(64),
  safeHeaderNames: ["authorization", "origin"],
  tokenEqualsEpochBaseline: true,
  ...overrides,
});

describe("classifyAuthBinding", () => {
  it("classifies an h3 success and h2 rejection as HTTP/3 QUIC binding", () => {
    expect(classifyAuthBinding([
      observation("brave-natural", 200, { protocol: "h3", networkRouteEqualsBaseline: true }),
      observation("brave-h2-natural", 401, { protocol: "h2", networkRouteEqualsBaseline: true }),
    ])).toMatchObject({
      kind: "http3-quic-bound",
      operation: "messaging-read",
      evidenceContexts: ["brave-natural", "brave-h2-natural"],
    });
  });

  it("classifies a browser h2 success and Node h2 rejection as TLS client binding", () => {
    expect(classifyAuthBinding([
      observation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true }),
      observation("node-http2", 401, { protocol: "h2", networkRouteEqualsBaseline: true }),
    ])).toMatchObject({
      kind: "tls-client-bound",
      operation: "messaging-read",
      evidenceContexts: ["brave-h2-natural", "node-http2"],
    });
  });

  it("classifies a new gateway connection rejection as connection-instance binding", () => {
    expect(classifyAuthBinding([
      observation("node-gateway", 101, { connectionEqualsPrevious: true }),
      observation("node-gateway", 401, { connectionEqualsPrevious: false }),
    ])).toMatchObject({
      kind: "connection-instance-bound",
      operation: "gateway-handshake",
      evidenceContexts: ["node-gateway", "node-gateway"],
    });
  });

  it("does not classify observations from different auth epochs", () => {
    expect(classifyAuthBinding([
      observation("brave-natural", 200, { protocol: "h3" }),
      observation("brave-h2-natural", 401, { protocol: "h2", authEpoch: "epoch-b" }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });

  it("does not classify an h3 and h2 pair with different endpoints", () => {
    expect(classifyAuthBinding([
      observation("brave-natural", 200, { protocol: "h3" }),
      observation("brave-h2-natural", 401, {
        protocol: "h2",
        endpointPath: "/messagingcoreservice.MessagingCoreService/GetConversation",
      }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });

  it("does not classify browser and Node h2 requests with different safe header names", () => {
    expect(classifyAuthBinding([
      observation("brave-h2-natural", 200, { protocol: "h2" }),
      observation("node-http2", 401, { protocol: "h2", safeHeaderNames: ["authorization"] }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });

  it.each([
    ["an endpoint", { endpointPath: "/messagingcoreservice.MessagingCoreService/GetConversation" }],
    ["safe header names", { safeHeaderNames: ["authorization"] }],
  ] as const)("does not claim server-side browser binding when %s differs", (_identity, rejectedOverrides) => {
    expect(classifyAuthBinding([
      observation("node-http1", 200, {
        protocol: "http/1.1",
        networkRouteEqualsBaseline: true,
        connectionEqualsPrevious: true,
        browserProcessEqualsPrevious: true,
        bootstrapStage: "ready",
      }),
      observation("node-http2", 401, {
        protocol: "http/1.1",
        networkRouteEqualsBaseline: true,
        connectionEqualsPrevious: true,
        browserProcessEqualsPrevious: true,
        bootstrapStage: "ready",
        ...rejectedOverrides,
      }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });

  it("does not classify transport-only observations", () => {
    expect(classifyAuthBinding([
      observation("brave-natural", undefined, { transportError: "tls" }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });
});
