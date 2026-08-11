import { describe, expect, it, vi } from "vitest";
import { CompatibilityGuard, SUPPORTED_ASSETS, type CompatibilityProbe } from "../../src/compat/guard.js";
import type { AssetLoaderLike } from "../../src/compat/asset-loader.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account-1",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
    assets: SUPPORTED_ASSETS,
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("CompatibilityGuard", () => {
  it("stops on metadata mismatch before reading any asset", async () => {
    const loadVerified = vi.fn<AssetLoaderLike["loadVerified"]>();
    const value = session();
    const mismatched: SessionExport = {
      ...value,
      assets: value.assets.map((asset, index) => index === 0 ? { ...asset, size: asset.size + 1 } : asset),
    };
    const guard = new CompatibilityGuard({ loadVerified }, {
      inspect: vi.fn(),
    });

    await expect(guard.verify(mismatched)).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    expect(loadVerified).not.toHaveBeenCalled();
  });

  it("reports verified assets, unique modules, and WASM shape", async () => {
    const loadVerified = vi.fn<AssetLoaderLike["loadVerified"]>(async (record) => new TextEncoder().encode(record.filename));
    const probe: CompatibilityProbe = {
      inspect: vi.fn(async () => ({
        modules: [{ capability: "content-envelope", moduleId: "crypto" }],
        wasmImports: ["env.memory"],
        wasmExports: ["run"],
      })),
    };
    const guard = new CompatibilityGuard({ loadVerified }, probe);

    await expect(guard.verify(session())).resolves.toMatchObject({
      buildId: "8dd50222",
      assets: SUPPORTED_ASSETS.map(({ filename, sha256, size }) => ({ filename, sha256, size })),
      modules: [{ capability: "content-envelope", moduleId: "crypto" }],
      wasmImports: ["env.memory"],
      wasmExports: ["run"],
    });
    expect(loadVerified).toHaveBeenCalledTimes(4);
  });
});
