import { describe, expect, it } from "vitest";
import { createMessagingStateFromBrowserSnapshot } from "../../src/session/browser-export.js";
import type { IndexedDbSnapshot } from "../../src/session/types.js";

function indexedDbWithRootWrappingKey(): IndexedDbSnapshot {
  return {
    databases: [{
      name: "keyval-store",
      version: 1,
      stores: [{
        name: "keyval",
        keyPath: null,
        autoIncrement: false,
        indexes: [],
        records: [{
          key: "uds.e2eeTempKey.undefined",
          value: JSON.stringify({
            identity: JSON.stringify({ identityKeyId: "AQID" }),
            rwk: "BAUG",
          }),
        }],
      }],
    }],
  };
}

describe("browser session export", () => {
  it("extracts only the persisted root wrapping key and never emits private identity fields", () => {
    const state = createMessagingStateFromBrowserSnapshot({
      localStorage: {},
      sessionStorage: {},
      indexedDb: indexedDbWithRootWrappingKey(),
    });

    expect(state).toEqual({
      rootWrappingKey: { data: "BAUG", identityKeyId: "AQID" },
      friendDevices: {},
    });
    expect(JSON.stringify(state)).not.toContain("cleartextPrivateKey");
  });

  it("extracts a resumed root wrapping key from the browser session storage location", () => {
    const state = createMessagingStateFromBrowserSnapshot({
      localStorage: {},
      sessionStorage: {
        "uds.e2eeIwekKey.243100254121636": JSON.stringify({
          data: "BAUG",
          identityKeyId: "AQID",
        }),
      },
      indexedDb: { databases: [] },
    });

    expect(state).toEqual({
      rootWrappingKey: { data: "BAUG", identityKeyId: "AQID" },
      friendDevices: {},
    });
  });

  it("fails closed when the browser has no resumed root wrapping key", () => {
    expect(() => createMessagingStateFromBrowserSnapshot({
      localStorage: {},
      sessionStorage: {},
      indexedDb: { databases: [] },
    })).toThrow("persisted messaging key state");
  });
});
