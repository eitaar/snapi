import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { parseSessionExport } from "../../src/session/schema.js";

function validSession(): unknown {
  return {
    formatVersion: 1,
    accountId: "account-1",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: {
      httpToken: "http-token",
      gatewayToken: "gateway-token",
      cookieHeader: "sc-a=secret",
      requestHeaders: { "x-snap-client-user-agent": "web" },
    },
    assets: [
      {
        kind: "javascript",
        filename: "bundle.js",
        sha256: "a".repeat(64),
        size: 123,
      },
      {
        kind: "wasm",
        filename: "runtime.wasm",
        sha256: "b".repeat(64),
        size: 456,
      },
    ],
    localStorage: { device: "value" },
    indexedDb: {
      databases: [
        {
          name: "snap-db",
          version: 1,
          stores: [
            {
              name: "keys",
              keyPath: null,
              autoIncrement: false,
              indexes: [],
              records: [{ key: "primary", value: { bytes: "AQID" } }],
            },
          ],
        },
      ],
    },
  };
}

function expectInvalid(value: unknown): void {
  try {
    parseSessionExport(value);
    throw new Error("expected parseSessionExport to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INVALID_SESSION_EXPORT");
  }
}

describe("parseSessionExport", () => {
  it("accepts a complete build 8dd50222 export", () => {
    const parsed = parseSessionExport(validSession());
    expect(parsed.accountId).toBe("account-1");
    expect(parsed.assets).toHaveLength(2);
  });

  it("rejects a missing gateway token", () => {
    const value = validSession() as { auth: { gatewayToken?: string } };
    delete value.auth.gatewayToken;
    expectInvalid(value);
  });

  it("rejects any other build", () => {
    const value = validSession() as { buildId: string };
    value.buildId = "future-build";
    expectInvalid(value);
  });

  it("rejects a malformed SHA-256 digest", () => {
    const value = validSession() as { assets: { sha256: string }[] };
    value.assets[0]!.sha256 = "not-a-digest";
    expectInvalid(value);
  });

  it("rejects an invalid export timestamp", () => {
    const value = validSession() as { exportedAt: string };
    value.exportedAt = "yesterday";
    expectInvalid(value);
  });
});
