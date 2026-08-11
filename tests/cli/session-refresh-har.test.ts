import { describe, expect, it, vi } from "vitest";
import { runSessionRefreshHar } from "../../src/cli/commands/session-refresh-har.js";

describe("session refresh-har command", () => {
  it("imports, refreshes, and atomically persists before printing a safe summary", async () => {
    const stdout: string[] = [];
    const execute = vi.fn(async () => ({ buildId: "8dd50222" as const, refreshedAt: "2026-08-11T04:00:00.000Z" }));
    const code = await runSessionRefreshHar(
      ["private/fresh.har"],
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { execute, output: "json" },
    );
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledWith("private/fresh.har");
    expect(JSON.parse(stdout[0]!)).toEqual({
      type: "session.refreshed",
      buildId: "8dd50222",
      refreshedAt: "2026-08-11T04:00:00.000Z",
    });
  });

  it("rejects extra arguments before reading secrets", async () => {
    const stderr: string[] = [];
    const execute = vi.fn();
    await expect(runSessionRefreshHar(
      ["one.har", "two.har"],
      { version: "0.1.0", stdout: () => undefined, stderr: (line) => stderr.push(line) },
      { execute },
    )).resolves.toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
