import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLoader } from "../../src/compat/asset-loader.js";

const bytes = new TextEncoder().encode("verified asset");
const digest = createHash("sha256").update(bytes).digest("hex");

describe("AssetLoader", () => {
  it("returns bytes only after size and SHA-256 verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-assets-"));
    await writeFile(join(dir, "bundle.js"), bytes);
    const loader = new AssetLoader(dir);

    await expect(
      loader.loadVerified({ kind: "javascript", filename: "bundle.js", sha256: digest, size: bytes.length }),
    ).resolves.toEqual(bytes);
  });

  it("fails closed for missing files, size mismatches, digest mismatches, and traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-assets-bad-"));
    await writeFile(join(dir, "bundle.js"), bytes);
    const loader = new AssetLoader(dir);
    const base = { kind: "javascript" as const, filename: "bundle.js", sha256: digest, size: bytes.length };

    await expect(loader.loadVerified({ ...base, filename: "missing.js" })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    await expect(loader.loadVerified({ ...base, size: bytes.length + 1 })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    await expect(loader.loadVerified({ ...base, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    await expect(loader.loadVerified({ ...base, filename: "../bundle.js" })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });
});
