import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";

describe("snap --version", () => {
  it("prints the injected package version", async () => {
    const stdout: string[] = [];
    const code = await main(["--version"], {
      version: "0.1.0",
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout).toEqual(["0.1.0"]);
  });
});
