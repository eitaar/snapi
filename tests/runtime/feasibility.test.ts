import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  REQUIRED_CHECKS,
  formatFeasibilityReport,
  runFeasibilityGate,
} from "../../src/runtime/feasibility.js";
import { main } from "../../src/cli/index.js";

describe("ContentEnvelope feasibility gate", () => {
  it("runs all required checks in the exact order", async () => {
    const order: string[] = [];
    const report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: [{ filename: "bundle.js", sha256: "a".repeat(64), size: 1 }],
      runCheck: async (name) => {
        order.push(name);
      },
    });

    expect(order).toEqual(REQUIRED_CHECKS);
    expect(report.checks.map(({ name, status }) => ({ name, status }))).toEqual(
      REQUIRED_CHECKS.map((name) => ({ name, status: "passed" })),
    );
  });

  it("records the first typed failure, redacts it, and stops later checks", async () => {
    const order: string[] = [];
    const report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: [],
      runCheck: async (name) => {
        order.push(name);
        if (name === "wasm_instantiated") {
          throw new AppError("UNSUPPORTED_BUILD", "WASM import mismatch", {
            gatewayToken: "must-not-leak",
          });
        }
      },
    });

    expect(order).toEqual(REQUIRED_CHECKS.slice(0, 5));
    expect(report.checks.at(-1)).toMatchObject({
      name: "wasm_instantiated",
      status: "failed",
      errorCode: "UNSUPPORTED_BUILD",
    });
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
    expect(formatFeasibilityReport(report, "json")).not.toContain("must-not-leak");
  });

  it("routes snap debug doctor --runtime through an injected command", async () => {
    const stdout: string[] = [];
    const runRuntimeDoctor = vi.fn(async () => 0);
    const code = await main(
      ["debug", "doctor", "--runtime"],
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { runRuntimeDoctor },
    );

    expect(code).toBe(0);
    expect(runRuntimeDoctor).toHaveBeenCalledOnce();
  });

  it("formats one safe human line per completed check", async () => {
    const report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: [],
      runCheck: async () => undefined,
    });
    expect(formatFeasibilityReport(report, "human").split("\n")).toHaveLength(REQUIRED_CHECKS.length + 1);
  });
});
