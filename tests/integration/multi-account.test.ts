import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountProfileStore,
  AppError,
  resolveAppConfig,
  SnapchatClient,
  type AccountProfileRecord,
  type AccountProfileSummary,
  type AccountProfileV1,
  type ResolveAppConfigOptions,
} from "../../src/index.js";
import type { AppConfig } from "../../src/config.js";
import { AccountLock } from "../../src/session/account-lock.js";
import type { SessionExport } from "../../src/session/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(accountId: string, buildId: "8dd50222" | "da4d065e"): SessionExport {
  return {
    formatVersion: 1,
    accountId,
    buildId,
    exportedAt: "2026-08-15T00:00:00.000Z",
    auth: {
      httpToken: `http-${accountId}`,
      gatewayToken: `gateway-${accountId}`,
      tokenRefreshedAt: "2026-08-15T00:00:00.000Z",
      cookieHeader: `web=${accountId}`,
      ssoCookieHeader: `sso=${accountId}`,
      requestHeaders: { "mcs-cof-ids-bin": "cof" },
    },
    assets: [],
    localStorage: {},
    sessionStorage: {},
    indexedDb: { databases: [] },
  };
}

async function fakeComponents(config: AppConfig, events: string[]) {
  const lock = await new AccountLock(config.lockDir).acquire(config.accountId);
  const label = config.accountAlias ?? config.accountId;
  return {
    messaging: {
      sendText: vi.fn(async () => ({ clientMessageId: `${label}-text`, status: "confirmed" as const })),
      messages: vi.fn(() => (async function* () {})()),
    },
    media: {
      sendPhotoSnap: vi.fn(async () => ({ clientMessageId: `${label}-snap`, status: "confirmed" as const })),
    },
    friends: {
      list: vi.fn(async () => ({
        syncedAt: "2026-08-15T00:00:00.000Z",
        status: "success" as const,
        friends: [],
        incomingRequests: [],
      })),
      listEasy: vi.fn(async () => ({ friends: [] })),
    },
    gateway: {
      connect: vi.fn(async () => { events.push(`${label}:gateway.connect`); }),
      events: vi.fn(() => (async function* () {})()),
      status: vi.fn(() => "idle" as const),
      close: vi.fn(async () => { events.push(`${label}:gateway.close`); }),
    },
    runtime: {
      shutdown: vi.fn(async () => { events.push(`${label}:runtime.shutdown`); }),
    },
    lock,
  };
}

describe("multi-account public API", () => {
  it("resolves profile configs from the public API without exposing session credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-multi-account-"));
    roots.push(root);
    const accountsDir = join(root, "private", "accounts");
    const store = new AccountProfileStore(accountsDir);
    const mainSessionFile = join(root, "private", "sessions", "main.json");
    const mainAssetDir = join(root, "private", "assets", "da4d065e");

    await store.add("main", { sessionFile: mainSessionFile, assetDir: mainAssetDir });

    const options: ResolveAppConfigOptions = { accountAlias: "main", cwd: root };
    const config = await resolveAppConfig(options, {
      accountsDir,
      loadSession: async (path) => {
        expect(path).toBe(mainSessionFile);
        return session("account-main", "da4d065e");
      },
    });

    const record: AccountProfileRecord = await store.read("main");
    const summary: AccountProfileSummary = { alias: record.alias, status: "ready" };
    const profile = JSON.parse(await readFile(store.pathFor("main"), "utf8")) as AccountProfileV1;

    expect(profile.formatVersion).toBe(1);
    expect(summary).toEqual({ alias: "main", status: "ready" });
    expect(config).toMatchObject({
      accountAlias: "main",
      accountId: "account-main",
      buildId: "da4d065e",
      sessionFile: mainSessionFile,
      assetDir: mainAssetDir,
      lockDir: join(accountsDir, ".locks"),
      output: "human",
    });
    expect(config).not.toHaveProperty("auth");
    expect(config).not.toHaveProperty("httpToken");
    expect(config.cookieHeader).toBeUndefined();
    expect(config.ssoCookieHeader).toBeUndefined();
  });

  it("keeps different accounts open concurrently and rejects a second client for the same account", async () => {
    const root = await mkdtemp(join(tmpdir(), "snaapi-multi-client-"));
    roots.push(root);
    const accountsDir = join(root, "private", "accounts");
    const store = new AccountProfileStore(accountsDir);
    const sessions = new Map<string, SessionExport>();

    async function addProfile(
      alias: string,
      accountId: string,
      buildId: "8dd50222" | "da4d065e",
    ): Promise<void> {
      const sessionFile = join(root, "private", "sessions", `${alias}.json`);
      const assetDir = join(root, "private", "assets", buildId);
      await store.add(alias, { sessionFile, assetDir });
      sessions.set(sessionFile, session(accountId, buildId));
    }

    await addProfile("main", "account-main", "da4d065e");
    await addProfile("bot", "account-bot", "8dd50222");
    await addProfile("main-copy", "account-main", "da4d065e");

    const loadProfileSession = async (path: string): Promise<SessionExport> => {
      const value = sessions.get(path);
      if (value === undefined) {
        throw new AppError("INVALID_CONFIG", "Missing fake session", { path });
      }
      return value;
    };

    const mainConfig = await resolveAppConfig({ accountAlias: "main", cwd: root }, {
      accountsDir,
      loadSession: loadProfileSession,
    });
    const botConfig = await resolveAppConfig({ accountAlias: "bot", cwd: root }, {
      accountsDir,
      loadSession: loadProfileSession,
    });
    const mainCopyConfig = await resolveAppConfig({ accountAlias: "main-copy", cwd: root }, {
      accountsDir,
      loadSession: loadProfileSession,
    });

    const events: string[] = [];
    const main = await SnapchatClient.create(mainConfig, { compose: (config) => fakeComponents(config, events) });
    const bot = await SnapchatClient.create(botConfig, { compose: (config) => fakeComponents(config, events) });

    await expect(
      SnapchatClient.create(mainCopyConfig, { compose: (config) => fakeComponents(config, events) }),
    ).rejects.toMatchObject({ code: "CRYPTO_STATE_CONFLICT" });

    await bot.close();
    await main.close();

    expect(events).toEqual([
      "bot:gateway.close",
      "bot:runtime.shutdown",
      "main:gateway.close",
      "main:runtime.shutdown",
    ]);
  });
});
