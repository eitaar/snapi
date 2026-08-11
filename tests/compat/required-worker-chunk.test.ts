import { describe, expect, it, vi } from "vitest";
import { CompatibilityGuard } from "../../src/compat/guard.js";
import type { SessionExport } from "../../src/session/types.js";

describe("required worker chunk manifest", () => {
  it("rejects the observed three-file manifest that omits the dynamically loaded worker chunk", async () => {
    const session: SessionExport = {
      formatVersion: 1,
      accountId: "account-1",
      buildId: "8dd50222",
      exportedAt: "2026-08-10T00:00:00.000Z",
      auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
      assets: [
        {
          kind: "javascript",
          filename: "41f8a232e0dafca526c7.js",
          sha256: "9ea45314e4f13777330816567d68b146e9a3e4a02973ed54560a3ca65463980b",
          size: 8_977_740,
        },
        {
          kind: "javascript",
          filename: "4577c38d10436a1f90f1.chunk.js",
          sha256: "e96e503d349d315c99b396bab35af25fbf6714c35fc73707df0c02accca10a13",
          size: 66_137,
        },
        {
          kind: "wasm",
          filename: "903641c0ba985b2dcd13.wasm",
          sha256: "2ce913a96d256605ea3b9998e71a65ee93b4f736fa4289d27490ed7fa5a95cd5",
          size: 12_326_439,
        },
      ],
      localStorage: {},
      indexedDb: { databases: [] },
    };
    const loadVerified = vi.fn(async () => new Uint8Array());
    const guard = new CompatibilityGuard({ loadVerified }, {
      inspect: vi.fn(async () => ({ modules: [], wasmImports: [], wasmExports: [] })),
    });

    await expect(guard.verify(session)).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
    expect(loadVerified).not.toHaveBeenCalled();
  });
});
