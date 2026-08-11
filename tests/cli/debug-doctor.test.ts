import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { REQUIRED_CHECKS, type FeasibilityReport } from "../../src/runtime/feasibility.js";
import {
  runRuntimeDoctor,
  type PreparedRuntimeDoctor,
} from "../../src/cli/commands/debug-doctor.js";

function prepared(
  runCheck: PreparedRuntimeDoctor["runCheck"] = async () => undefined,
): PreparedRuntimeDoctor {
  return {
    output: "json",
    verifiedAssets: [{ filename: "bundle.js", sha256: "a".repeat(64), size: 1 }],
    runCheck,
    shutdown: vi.fn(async () => undefined),
  };
}

describe("runtime doctor command", () => {
  it("runs the prepared gate, emits JSON, writes the report, and shuts down", async () => {
    const stdout: string[] = [];
    const state = prepared();
    const writeReport = vi.fn(async (_report: FeasibilityReport) => undefined);

    const code = await runRuntimeDoctor(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { prepare: async () => state, writeReport },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      checks: REQUIRED_CHECKS.map((name) => ({ name, status: "passed" })),
    });
    expect(writeReport).toHaveBeenCalledOnce();
    expect(state.shutdown).toHaveBeenCalledOnce();
  });

  it("maps preparation failures to a configuration report and exit code 3", async () => {
    const stdout: string[] = [];
    const writeReport = vi.fn(async (_report: FeasibilityReport) => undefined);

    const code = await runRuntimeDoctor(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { prepare: async () => { throw new Error("unsafe details"); }, writeReport },
    );

    expect(code).toBe(3);
    expect(stdout.join("\n")).toContain("FAIL assets_verified");
    expect(stdout.join("\n")).not.toContain("unsafe details");
  });

  it("returns runtime exit code 4 for missing messaging state and still shuts down", async () => {
    const stdout: string[] = [];
    const state = prepared(async (name) => {
      if (name === "content_envelope_created") {
        throw new AppError("SESSION_REEXPORT_REQUIRED", "Fresh login messaging state is required");
      }
    });

    const code = await runRuntimeDoctor(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { prepare: async () => state, writeReport: async () => undefined },
    );

    expect(code).toBe(4);
    expect(stdout.join("\n")).toContain("SESSION_REEXPORT_REQUIRED");
    expect(state.shutdown).toHaveBeenCalledOnce();
  });
});
