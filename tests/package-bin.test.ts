import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
}

describe("package command aliases", () => {
  test("exposes both snap and snaapi commands", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as PackageManifest;

    const bin = manifest.bin ?? {};

    expect(bin).toHaveProperty("snap", "./dist/cli/index.js");
    expect(bin).toHaveProperty("snaapi", "./dist/cli/index.js");
    expect(bin.snaapi).toBe(bin.snap);
  });

  test("documents multi-account profile commands and environment selection", async () => {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("snaapi account add");
    expect(readme).toContain("snaapi --account");
    expect(readme).toContain("SNAAPI_ACCOUNT");
    expect(readme).toContain("SNAAPI_ACCOUNTS_DIR");
  });
});
