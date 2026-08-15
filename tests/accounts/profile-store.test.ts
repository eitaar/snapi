import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AccountProfileStore, assertAccountAlias } from "../../src/accounts/profile-store.js";

describe("AccountProfileStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createStore(): Promise<{ root: string; store: AccountProfileStore }> {
    const root = await mkdtemp(join(tmpdir(), "snaapi-accounts-"));
    roots.push(root);
    return { root, store: new AccountProfileStore(root) };
  }

  test("rejects traversal and accepts a bounded alias", () => {
    expect(assertAccountAlias("main.bot-1")).toBe("main.bot-1");
    expect(() => assertAccountAlias("../main")).toThrowError(/alias/i);
    expect(() => assertAccountAlias("a".repeat(65))).toThrowError(/alias/i);
  });

  test("writes versioned relative path metadata atomically", async () => {
    const { root, store } = await createStore();
    const sessionFile = join(root, "sessions", "main.json");
    const assetDir = join(root, "assets", "da4d065e");

    await store.add("main", { sessionFile, assetDir });

    expect(await store.read("main")).toEqual({ alias: "main", sessionFile, assetDir });
    expect(store.pathFor("main")).toBe(join(root, "main.json"));
    expect(JSON.parse(await readFile(join(root, "main.json"), "utf8"))).toEqual({
      formatVersion: 1,
      sessionFile: "sessions/main.json",
      assetDir: "assets/da4d065e",
    });
    expect((await readdir(root)).filter((name) => name.includes("tmp"))).toEqual([]);
  });

  test("fails closed instead of replacing an existing alias", async () => {
    const { root, store } = await createStore();
    const input = { sessionFile: join(root, "one.json"), assetDir: join(root, "assets") };
    await store.add("main", input);
    await expect(store.add("main", input)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("removes the temporary file when exclusive installation fails", async () => {
    const { root } = await createStore();
    const store = new AccountProfileStore(root, {
      installExclusive: async () => {
        throw new Error("forced install failure");
      },
    });

    await expect(store.add("main", {
      sessionFile: join(root, "session.json"),
      assetDir: join(root, "assets"),
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
    await expect(store.read("main")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("returns canonical paths matching read for relative inputs", async () => {
    const { root, store } = await createStore();
    const added = await store.add("relative", {
      sessionFile: "sessions/relative.json",
      assetDir: "assets/relative",
    });

    await expect(store.read("relative")).resolves.toEqual(added);
    expect(added).toEqual({
      alias: "relative",
      sessionFile: join(root, "sessions", "relative.json"),
      assetDir: join(root, "assets", "relative"),
    });
  });

  test("rejects malformed, unsupported, absolute, and incomplete profiles", async () => {
    const { root, store } = await createStore();
    const profilePath = join(root, "broken.json");
    await expect(store.read("broken")).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    await store.add("broken", { sessionFile: join(root, "session.json"), assetDir: join(root, "assets") });
    await expect(store.read("broken")).resolves.toBeDefined();

    await import("node:fs/promises").then(({ writeFile }) => writeFile(profilePath, "{", "utf8"));
    await expect(store.read("broken")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("rejects unsupported versions, absolute stored paths, and missing fields", async () => {
    const { root, store } = await createStore();
    const writeProfile = async (value: unknown) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "main.json"), JSON.stringify(value), "utf8");
    };

    await writeProfile({ formatVersion: 2, sessionFile: "session.json", assetDir: "assets" });
    await expect(store.read("main")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await writeProfile({ formatVersion: 1, sessionFile: root, assetDir: "assets" });
    await expect(store.read("main")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await writeProfile({ formatVersion: 1, sessionFile: "session.json" });
    await expect(store.read("main")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("lists aliases in deterministic order with non-secret summaries", async () => {
    const { root, store } = await createStore();
    await store.add("zeta", { sessionFile: join(root, "missing.json"), assetDir: join(root, "assets") });
    await store.add("alpha", { sessionFile: join(root, "missing-2.json"), assetDir: join(root, "assets") });

    await expect(store.list()).resolves.toEqual([
      { alias: "alpha", status: "missing-session" },
      { alias: "zeta", status: "missing-session" },
    ]);
  });
});
