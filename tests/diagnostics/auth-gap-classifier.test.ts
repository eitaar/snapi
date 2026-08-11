import { describe, expect, it } from "vitest";
import { classifyAuthGap } from "../../src/diagnostics/auth-gap-classifier.js";
import type { SafeAuthGapObservation } from "../../src/diagnostics/auth-gap-types.js";

const result = (
  context: SafeAuthGapObservation["context"],
  status: number,
): SafeAuthGapObservation => ({
  authEpoch: "edge-capture-1",
  context,
  endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
  method: "POST",
  startedAt: "2026-08-11T00:00:00.000Z",
  status,
  requestBodyBytes: 16,
  requestBodySha256: "a".repeat(64),
  safeHeaderNames: ["authorization", "content-type"],
});

describe("classifyAuthGap", () => {
  it("identifies a missing web cookie", () => {
    expect(classifyAuthGap([
      result("node-bearer", 401),
      result("node-web-cookie", 200),
    ])).toEqual({ kind: "web-cookie-required", directNodeStillViable: true });
  });

  it("identifies browser execution binding", () => {
    expect(classifyAuthGap([
      result("edge-page-replay", 200),
      result("node-http2", 401),
    ])).toEqual({ kind: "browser-context-required", directNodeStillViable: false });
  });

  it("does not overclaim when the browser replay also fails", () => {
    expect(classifyAuthGap([
      result("edge-original", 200),
      result("edge-page-replay", 401),
    ])).toEqual({ kind: "request-freshness-or-single-use", directNodeStillViable: undefined });
  });

  it("returns insufficient evidence for an empty or mismatched comparison", () => {
    expect(classifyAuthGap([])).toEqual({ kind: "insufficient-evidence", directNodeStillViable: undefined });
    const mismatched = result("node-bearer", 401);
    const differentBody = { ...result("node-web-cookie", 200), requestBodySha256: "b".repeat(64) };
    expect(classifyAuthGap([mismatched, differentBody])).toEqual({
      kind: "insufficient-evidence",
      directNodeStillViable: undefined,
    });
  });

  it("records a protocol difference when both HTTP/2 and Edge replay succeed", () => {
    expect(classifyAuthGap([
      result("edge-page-replay", 200),
      result("node-http2", 200),
    ])).toEqual({ kind: "http2-or-tls-difference", directNodeStillViable: undefined });
  });
});
