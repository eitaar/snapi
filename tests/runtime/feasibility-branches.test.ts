import { describe, expect, it } from "vitest";
import {
  formatFeasibilityMarkdown,
  formatFeasibilityReport,
  runFeasibilityGate,
  type FeasibilityReport,
} from "../../src/runtime/feasibility.js";

describe("feasibility report boundary branches", () => {
  it("normalizes an untyped failure, clamps negative duration, and preserves an injected start time", async () => {
    const times = [10, 5];
    const report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: [],
      startedAt: "2026-08-11T00:00:00.000Z",
      now: () => times.shift()!,
      runCheck: async () => { throw new TypeError("private detail"); },
    });

    expect(report.startedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(report.checks).toEqual([{
      name: "assets_verified",
      status: "failed",
      durationMs: 0,
      errorCode: "CRYPTO_RUNTIME_FAILED",
      errorMessage: "Feasibility check failed",
    }]);
    expect(JSON.stringify(report)).not.toContain("private detail");
  });

  it("formats human failures both with and without typed error details", () => {
    const base: FeasibilityReport = {
      buildId: "8dd50222",
      startedAt: "2026-08-11T00:00:00.000Z",
      verifiedAssets: [],
      checks: [{ name: "assets_verified", status: "failed", durationMs: 2 }],
    };
    expect(formatFeasibilityReport(base, "human")).toContain("FAIL assets_verified 2ms");

    const typed: FeasibilityReport = {
      ...base,
      checks: [{
        name: "assets_verified",
        status: "failed",
        durationMs: 3,
        errorCode: "UNSUPPORTED_BUILD",
      }],
    };
    expect(formatFeasibilityReport(typed, "human"))
      .toContain("(UNSUPPORTED_BUILD: failed)");
  });

  it("formats markdown for empty and populated asset lists", () => {
    const empty: FeasibilityReport = {
      buildId: "8dd50222",
      startedAt: "2026-08-11T00:00:00.000Z",
      verifiedAssets: [],
      checks: [],
    };
    expect(formatFeasibilityMarkdown(empty)).toContain("| _none_ | _none_ | 0 |");

    const populated: FeasibilityReport = {
      ...empty,
      verifiedAssets: [{ filename: "bundle.js", sha256: "a".repeat(64), size: 42 }],
      checks: [{ name: "assets_verified", status: "passed", durationMs: 1 }],
    };
    const markdown = formatFeasibilityMarkdown(populated);
    expect(markdown).toContain(`| bundle.js | ${"a".repeat(64)} | 42 |`);
    expect(markdown).toContain("| assets_verified | passed | 1 |  |  |");
  });
});
