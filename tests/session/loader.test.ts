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
        indexedDb: { databases: [] },
      }),
      "utf8",
    );

    await expect(loadSession(file)).resolves.toMatchObject({ accountId: "account-1" });
  });
});
