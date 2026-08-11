import { describe, expect, it, vi } from "vitest";
import { runSessionImport } from "../../src/cli/commands/session-import.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      version: "0.1.0",
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

describe("session import command", () => {
  it("imports one validated export and prints only a safe summary", async () => {
    const output = io();
    const importSession = vi.fn(async () => ({ buildId: "8dd50222" as const, assetCount: 4 }));

    await expect(runSessionImport(["private/export.json"], output.value, {
      importSession,
      output: "json",
    })).resolves.toBe(0);

    expect(importSession).toHaveBeenCalledWith("private/export.json");
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "session.imported",
      buildId: "8dd50222",
      assetCount: 4,
    });
  });

  it("rejects missing or extra paths before reading a session", async () => {
    const output = io();
    const importSession = vi.fn();
    await expect(runSessionImport([], output.value, { importSession })).resolves.toBe(2);
    await expect(runSessionImport(["a", "b"], output.value, { importSession })).resolves.toBe(2);
    expect(importSession).not.toHaveBeenCalled();
  });
});
