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
      ssoCookieHeader: "account-session=secret",
      ssoScuid: "sso-client-id",
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
    sessionStorage: {},
    messaging: {
      keyInitializationInfo: "AQID",
      rootWrappingKey: {
        data: "BAUG",
        identityKeyId: "BwgJ",
      },
      friendDevices: {
        "11111111-1111-4111-8111-111111111111": [{ deviceId: "device-1" }],
      },
    },
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
    expect(parsed).toMatchObject({
      auth: { ssoCookieHeader: "account-session=secret", ssoScuid: "sso-client-id" },
      messaging: { keyInitializationInfo: "AQID" },
    });
  });

  it("accepts login bootstrap state before the root wrapping key exists", () => {
    const value = validSession() as {
      sessionStorage: Record<string, string>;
      messaging: { rootWrappingKey?: unknown };
    };
    delete value.messaging.rootWrappingKey;
    value.sessionStorage.e2eeTempKey = "opaque serialized temporary identity";
    expect(parseSessionExport(value)).toMatchObject({
      sessionStorage: { e2eeTempKey: "opaque serialized temporary identity" },
      messaging: { keyInitializationInfo: "AQID" },
    });
  });

  it("rejects login initialization info without its temporary identity key", () => {
    const value = validSession() as { messaging: { rootWrappingKey?: unknown } };
    delete value.messaging.rootWrappingKey;
    expectInvalid(value);
  });

  it("rejects malformed messaging key material", () => {
    const value = validSession() as { messaging: { keyInitializationInfo: string } };
    value.messaging.keyInitializationInfo = "not base64!";
    expectInvalid(value);
  });

  it("rejects a missing gateway token", () => {
    const value = validSession() as { auth: { gatewayToken?: string } };
    delete value.auth.gatewayToken;
    expectInvalid(value);
  });

  it("rejects messaging state without bootstrap or resumed key material", () => {
    const value = validSession() as { messaging: { keyInitializationInfo?: string; rootWrappingKey?: unknown } };
    delete value.messaging.keyInitializationInfo;
    delete value.messaging.rootWrappingKey;
    expectInvalid(value);
  });

  it("rejects an invalid friend UUID", () => {
    const value = validSession() as { messaging: { friendDevices: Record<string, unknown> } };
    value.messaging.friendDevices = { "not-a-uuid": [] };
    expectInvalid(value);
  });

  it("rejects non-object friend device records", () => {
    const value = validSession() as { messaging: { friendDevices: Record<string, unknown> } };
    value.messaging.friendDevices = {
      "11111111-1111-4111-8111-111111111111": ["not-an-object"],
    };
    expectInvalid(value);
  });

  it("rejects invalid IndexedDB key paths and flags", () => {
    const value = validSession() as {
      indexedDb: { databases: Array<{ stores: Array<Record<string, unknown>> }> };
    };
    value.indexedDb.databases[0]!.stores[0]!.keyPath = [];
    expectInvalid(value);
  });

  it("defaults absent sessionStorage to an empty snapshot", () => {
    const value = validSession() as { sessionStorage?: unknown };
    delete value.sessionStorage;
    expect(parseSessionExport(value).sessionStorage).toEqual({});
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
