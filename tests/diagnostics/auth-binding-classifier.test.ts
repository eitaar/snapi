import { describe, expect, it } from "vitest";
import { classifyAuthBinding } from "../../src/diagnostics/auth-binding-classifier.js";
import type { SafeAuthBindingObservation } from "../../src/diagnostics/auth-binding-types.js";

const messagingPath = "/messagingcoreservice.MessagingCoreService/DeltaSync";
const gatewayPath = "/snapchat.gateway.Gateway/WebSocketConnect";
type ObservationOverrides = Omit<Partial<SafeAuthBindingObservation>,
  "networkRouteEqualsBaseline" | "requestBodyBytes" | "requestBodySha256"> & {
  readonly networkRouteEqualsBaseline?: boolean | undefined;
  readonly requestBodyBytes?: number | undefined;
  readonly requestBodySha256?: string | undefined;
};

function messagingObservation(
  context: SafeAuthBindingObservation["context"],
  status: number | undefined,
  overrides: ObservationOverrides = {},
): SafeAuthBindingObservation {
  return Object.fromEntries(Object.entries({
    authEpoch: "epoch-a",
    context,
    operation: "messaging-read",
    endpointPath: messagingPath,
    startedAt: "2026-08-13T13:37:56.814Z",
    ...(status === undefined ? {} : { status }),
    protocol: context === "node-http1" ? "http/1.1" : context === "dotnet-http3" ? "h3" : "h2",
    requestBodyBytes: 65,
    requestBodySha256: "a".repeat(64),
    safeHeaderNames: ["authorization", "content-type"],
    tokenEqualsEpochBaseline: true,
    ...overrides,
  }).filter(([, value]) => value !== undefined)) as unknown as SafeAuthBindingObservation;
}

function gatewayObservation(
  context: SafeAuthBindingObservation["context"],
  status: number | undefined,
  overrides: Partial<SafeAuthBindingObservation> = {},
): SafeAuthBindingObservation {
  return {
    authEpoch: "epoch-a",
    context,
    operation: "gateway-handshake",
    endpointPath: gatewayPath,
    startedAt: "2026-08-13T13:37:56.814Z",
    ...(status === undefined ? {} : { status }),
    protocol: "websocket",
    safeHeaderNames: ["origin", "sec-websocket-protocol"],
    tokenEqualsEpochBaseline: true,
    ...overrides,
  };
}

describe("classifyAuthBinding", () => {
  it("classifies an h3 browser success and h2 browser rejection only with explicit route controls", () => {
    expect(classifyAuthBinding([
      messagingObservation("brave-natural", 200, { protocol: "h3", networkRouteEqualsBaseline: true }),
      messagingObservation("brave-h2-natural", 401, { protocol: "h2", networkRouteEqualsBaseline: true }),
    ])).toMatchObject({
      kind: "http3-quic-bound",
      operation: "messaging-read",
      evidenceContexts: ["brave-natural", "brave-h2-natural"],
    });
  });

  it.each([
    ["missing successful route control", { networkRouteEqualsBaseline: undefined }, { networkRouteEqualsBaseline: true }],
    ["missing rejected route control", { networkRouteEqualsBaseline: true }, { networkRouteEqualsBaseline: undefined }],
    ["changed rejected route", { networkRouteEqualsBaseline: true }, { networkRouteEqualsBaseline: false }],
    ["wrong successful protocol", { protocol: "h2", networkRouteEqualsBaseline: true }, { protocol: "h2", networkRouteEqualsBaseline: true }],
    ["wrong rejected context", { protocol: "h3", networkRouteEqualsBaseline: true }, { context: "node-http2", protocol: "h2", networkRouteEqualsBaseline: true }],
  ] as const)("does not claim HTTP/3 binding with %s", (_reason, successOverrides, rejectedOverrides) => {
    expect(classifyAuthBinding([
      messagingObservation("brave-natural", 200, successOverrides),
      messagingObservation("brave-h2-natural", 401, rejectedOverrides),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("classifies browser h2 success and Node h2 rejection only on the same route", () => {
    expect(classifyAuthBinding([
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true }),
      messagingObservation("node-http2", 401, { protocol: "h2", networkRouteEqualsBaseline: true }),
    ])).toMatchObject({
      kind: "tls-client-bound",
      operation: "messaging-read",
      evidenceContexts: ["brave-h2-natural", "node-http2"],
    });
  });

  it.each([
    ["missing browser route", undefined, true],
    ["missing Node route", true, undefined],
    ["different Node route", true, false],
  ] as const)("does not claim TLS client binding with %s", (_reason, browserRoute, nodeRoute) => {
    expect(classifyAuthBinding([
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: browserRoute }),
      messagingObservation("node-http2", 401, { protocol: "h2", networkRouteEqualsBaseline: nodeRoute }),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("classifies a reload Gateway rejection as connection binding only with exact controls", () => {
    expect(classifyAuthBinding([
      gatewayObservation("brave-natural", 101, {
        connectionEqualsPrevious: true,
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
      }),
      gatewayObservation("brave-reload", 401, {
        connectionEqualsPrevious: false,
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
      }),
    ])).toMatchObject({
      kind: "connection-instance-bound",
      operation: "gateway-handshake",
      evidenceContexts: ["brave-natural", "brave-reload"],
    });
  });

  it.each([
    ["reversed status direction", 401, 101, {}, {}],
    ["wrong successful context", 101, 401, { context: "node-gateway" }, {}],
    ["wrong rejected context", 101, 401, {}, { context: "node-gateway" }],
    ["changed browser process", 101, 401, {}, { browserProcessEqualsPrevious: false }],
    ["changed route", 101, 401, {}, { networkRouteEqualsBaseline: false }],
    ["wrong transport", 101, 401, {}, { protocol: "h2" }],
  ] as const)("does not claim reload connection binding with %s", (
    _reason,
    successStatus,
    rejectedStatus,
    successOverrides,
    rejectedOverrides,
  ) => {
    expect(classifyAuthBinding([
      gatewayObservation("brave-natural", successStatus, {
        connectionEqualsPrevious: true,
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
        ...successOverrides,
      }),
      gatewayObservation("brave-reload", rejectedStatus, {
        connectionEqualsPrevious: false,
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
        ...rejectedOverrides,
      }),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("classifies same-context page replay rejection as token or body freshness binding", () => {
    expect(classifyAuthBinding([
      messagingObservation("brave-natural", 200, {
        protocol: "h3",
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
      }),
      messagingObservation("brave-page-replay", 401, {
        protocol: "h3",
        browserProcessEqualsPrevious: true,
        networkRouteEqualsBaseline: true,
      }),
    ])).toMatchObject({ kind: "token-freshness-bound" });
  });

  it("requires Worker success and page rejection in that direction for browser principal binding", () => {
    const controlled = {
      protocol: "h3" as const,
      browserProcessEqualsPrevious: true,
      networkRouteEqualsBaseline: true,
    };
    expect(classifyAuthBinding([
      messagingObservation("brave-worker-replay", 200, controlled),
      messagingObservation("brave-page-replay", 401, controlled),
    ])).toMatchObject({ kind: "browser-principal-bound" });
    expect(classifyAuthBinding([
      messagingObservation("brave-page-replay", 200, controlled),
      messagingObservation("brave-worker-replay", 401, controlled),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("requires exact complete and incomplete bootstrap labels", () => {
    const controlled = {
      protocol: "h3" as const,
      browserProcessEqualsPrevious: true,
      networkRouteEqualsBaseline: true,
    };
    expect(classifyAuthBinding([
      messagingObservation("brave-worker-replay", 200, { ...controlled, bootstrapStage: "complete" }),
      messagingObservation("brave-worker-replay", 401, { ...controlled, bootstrapStage: "incomplete" }),
    ])).toMatchObject({ kind: "bootstrap-sequence-bound" });
    expect(classifyAuthBinding([
      messagingObservation("brave-worker-replay", 200, { ...controlled, bootstrapStage: "ready" }),
      messagingObservation("brave-worker-replay", 401, { ...controlled, bootstrapStage: "not-ready" }),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("partitions Gateway and Messaging observations before comparing body identity", () => {
    expect(classifyAuthBinding([
      gatewayObservation("brave-natural", 101),
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true }),
      messagingObservation("node-http2", 401, { protocol: "h2", networkRouteEqualsBaseline: true }),
    ])).toMatchObject({ kind: "tls-client-bound", operation: "messaging-read" });
  });

  it.each([
    ["body byte length", { requestBodyBytes: undefined }],
    ["body hash", { requestBodySha256: undefined }],
  ] as const)("does not compare Messaging observations missing %s", (_field, missingIdentity) => {
    expect(classifyAuthBinding([
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true, ...missingIdentity }),
      messagingObservation("node-http2", 401, { protocol: "h2", networkRouteEqualsBaseline: true, ...missingIdentity }),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("does not classify observations from different auth epochs", () => {
    expect(classifyAuthBinding([
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true }),
      messagingObservation("node-http2", 401, {
        authEpoch: "epoch-b",
        protocol: "h2",
        networkRouteEqualsBaseline: true,
      }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });

  it.each([
    ["an endpoint", { endpointPath: "/messagingcoreservice.MessagingCoreService/GetGroups" }],
    ["safe header names", { safeHeaderNames: ["authorization"] }],
  ] as const)("does not compare Messaging observations when %s differs", (_identity, rejectedOverrides) => {
    expect(classifyAuthBinding([
      messagingObservation("brave-h2-natural", 200, { protocol: "h2", networkRouteEqualsBaseline: true }),
      messagingObservation("node-http2", 401, {
        protocol: "h2",
        networkRouteEqualsBaseline: true,
        ...rejectedOverrides,
      }),
    ])).toMatchObject({ kind: "insufficient-evidence" });
  });

  it("does not classify transport-only observations", () => {
    expect(classifyAuthBinding([
      messagingObservation("brave-natural", undefined, { transportError: "tls" }),
    ])).toMatchObject({ kind: "insufficient-evidence", operation: "messaging-read" });
  });
});
