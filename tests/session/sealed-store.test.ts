import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedSessionStore, type SessionProtector } from "../../src/session/sealed-store.js";
import { loadSession } from "../../src/session/loader.js";
import type { SessionExport } from "../../src/session/types.js";

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account-1",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: {
      httpToken: "http-token",
      gatewayToken: "gateway-token",
      cookieHeader: "cookie=value",
      requestHeaders: {},
    },
    assets: [],
    localStorage: {},
    sessionStorage: {},
    indexedDb: { databases: [] },
  };
}

const reversibleProtector: SessionProtector = {
  protect: async (plain) => Uint8Array.from(plain, (value) => value ^ 0xff),
  unprotect: async (sealed) => Uint8Array.from(sealed, (value) => value ^ 0xff),
};

describe("SealedSessionStore", () => {
  it("round-trips a session without writing bearer or cookie fields in plaintext", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-sealed-session-"));
    const path = join(dir, "session.json");
    const store = new SealedSessionStore(path, reversibleProtector);

    await store.write(session());
    const raw = await readFile(path, "utf8");

    expect(raw).toContain("snapchat-sealed-session");
    expect(raw).not.toContain("http-token");
    expect(raw).not.toContain("cookie=value");
    await expect(store.read()).resolves.toEqual(session());
  });

  it("migrates a legacy JSON session when explicitly requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-sealed-migration-"));
    const path = join(dir, "session.json");
    await writeFile(path, JSON.stringify(session()), "utf8");
    const store = new SealedSessionStore(path, reversibleProtector);

    await expect(store.readOrMigrateLegacy()).resolves.toEqual(session());
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("snapchat-sealed-session");
    expect(raw).not.toContain("gateway-token");
    await expect(readFile(`${path}.previous`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads a sealed session through the normal loader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-sealed-loader-"));
    const path = join(dir, "session.json");
    await new SealedSessionStore(path, reversibleProtector).write(session());

    await expect(loadSession(path, { protector: reversibleProtector })).resolves.toEqual(session());
  });
});
