import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("built snap CLI", () => {
  it("matches the package entry points and prints its version", () => {
    execFileSync(
      process.execPath,
      [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const cliEntry = resolve("dist/cli/index.js");
    const libraryEntry = resolve("dist/index.js");
    expect(existsSync(cliEntry)).toBe(true);
    expect(existsSync(libraryEntry)).toBe(true);

    const output = execFileSync(process.execPath, [cliEntry, "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output.trim()).toBe("0.1.0");
  });
});
