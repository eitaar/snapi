import { describe, expect, it, vi } from "vitest";
import { CompatibilityGuard, SUPPORTED_ASSETS, type CompatibilityProbe } from "../../src/compat/guard.js";
import { AppError } from "../../src/errors.js";
import type { SessionExport } from "../../src/session/types.js";

function validSession(): SessionExport {
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

const loader = {
  loadVerified: vi.fn(async () => new Uint8Array([1])),
};

const successfulProbe: CompatibilityProbe = {
  inspect: async () => ({ modules: [], wasmImports: [], wasmExports: ["run"] }),
};

describe("CompatibilityGuard rejection branches", () => {
  it("rejects an unsupported build before checking its manifest", async () => {
    const session = { ...validSession(), buildId: "new-build" } as unknown as SessionExport;
    await expect(new CompatibilityGuard(loader, successfulProbe).verify(session))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });

  it("rejects duplicate and missing manifest records", async () => {
    const base = validSession();
    const duplicate = { ...base, assets: [...base.assets, base.assets[0]!] };
    const missing = { ...base, assets: base.assets.slice(1) };

    await expect(new CompatibilityGuard(loader, successfulProbe).verify(duplicate))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    await expect(new CompatibilityGuard(loader, successfulProbe).verify(missing))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });

  it.each([
    ["kind", { kind: "wasm" as const }],
    ["sha256", { sha256: "0".repeat(64) }],
  ])("rejects a manifest with the wrong %s", async (_name, replacement) => {
    const base = validSession();
    const assets = base.assets.map((asset, index) => index === 0 ? { ...asset, ...replacement } : asset);
    await expect(new CompatibilityGuard(loader, successfulProbe).verify({ ...base, assets }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });

  it("preserves AppError probe failures and wraps ordinary failures", async () => {
    const preserved = new AppError("UNSUPPORTED_BUILD", "known failure");
    const probes: readonly [unknown, string][] = [
      [preserved, "known failure"],
      [new TypeError("unsafe detail"), "Build compatibility probe failed"],
      ["non-error", "Build compatibility probe failed"],
    ];

    for (const [failure, message] of probes) {
      const probe: CompatibilityProbe = { inspect: async () => { throw failure; } };
      await expect(new CompatibilityGuard(loader, probe).verify(validSession()))
        .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD", message });
    }
  });
});
