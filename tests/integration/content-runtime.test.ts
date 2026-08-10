import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runRuntimeDoctor } from "../../src/cli/commands/debug-doctor.js";

const live = process.env.SNAP_LIVE_TESTS === "1";

describe.skipIf(!live)("managed ContentEnvelope runtime", () => {
  it("passes all ten checks and writes the redacted report", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runRuntimeDoctor({
      version: "0.1.0",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code, stderr.join("\n")).toBe(0);
    expect(existsSync("docs/runtime-feasibility-report.md")).toBe(true);
    expect(stdout.join("\n")).not.toMatch(/cookie|authorization|gatewayToken|httpToken/i);
  }, 150_000);
});
