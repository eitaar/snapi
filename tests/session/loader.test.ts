import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSession } from "../../src/session/loader.js";

describe("loadSession", () => {
  it("reads UTF-8 JSON and validates it before returning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-session-"));
    const file = join(dir, "session.json");
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        accountId: "account-1",
        buildId: "8dd50222",
        exportedAt: "2026-08-10T00:00:00.000Z",
        auth: {
          httpToken: "http-token",
          gatewayToken: "gateway-token",
          cookieHeader: "cookie",
          requestHeaders: {},
        },
        assets: [],
        localStorage: {},
        indexedDb: { databases: [{
          name: "keys",
          version: 1,
          stores: [{
            name: "identity",
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            records: [{ key: "current", value: { bytes: { $bytes: "AQID" } } }],
          }],
        }] },
      }),
      "utf8",
    );

    const session = await loadSession(file);
    expect(session.accountId).toBe("account-1");
    const value = session.indexedDb.databases[0]!.stores[0]!.records[0]!.value;
    expect(value).toEqual({ bytes: new Uint8Array([1, 2, 3]) });
  });
});
