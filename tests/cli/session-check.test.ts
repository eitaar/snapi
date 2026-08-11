import { describe, expect, it, vi } from "vitest";
import { runSessionCheck } from "../../src/cli/commands/session-check.js";

describe("session check command", () => {
  it("prints only a safe validation summary", async () => {
    const stdout: string[] = [];
    const inspect = vi.fn(async () => ({ buildId: "8dd50222" as const, assetCount: 4 }));
    const code = await runSessionCheck(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { inspect, output: "json" },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({ type: "session.checked", buildId: "8dd50222", assetCount: 4 });
    expect(inspect).toHaveBeenCalledOnce();
  });
});
