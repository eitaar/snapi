import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import { runSessionImport } from "../../src/cli/commands/session-import.js";
import * as configModule from "../../src/config.js";
import { CompatibilityGuard } from "../../src/compat/guard.js";
import { AccountLock } from "../../src/session/account-lock.js";
import * as sessionLoaderModule from "../../src/session/loader.js";
import { SealedSessionStore } from "../../src/session/sealed-store.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      version: "0.1.0",
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    sessionFile: "C:/profiles/main-session.json",
    assetDir: "C:/profiles/main-assets",
    lockDir: "C:/profiles/accounts/.locks",
    accountId: "account-main",
    buildId: "8dd50222",
    output: "json",
    accountAlias: "main",
    ...overrides,
  };
}

function session(overrides: Partial<SessionExport> = {}): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account-main",
    buildId: "8dd50222",
    exportedAt: "2026-08-15T00:00:00.000Z",
    auth: {
      httpToken: "http-token",
      gatewayToken: "gateway-token",
      cookieHeader: "cookie=secret",
      requestHeaders: {},
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
    ...overrides,
  };
}

function lockDirOf(value: object): string {
  return (value as Record<string, unknown>).lockDirectory as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session import command", () => {
  it("uses the injected profile session assets and lock root instead of legacy config", async () => {
    const output = io();
    const selected = config();
    const acquiredLockDirs: string[] = [];
    const persistedPaths: string[] = [];
    const loadConfig = vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(sessionLoaderModule, "loadSession").mockResolvedValue(session() as never);
    vi.spyOn(AccountLock.prototype, "acquire").mockImplementation(async function (this: object) {
      acquiredLockDirs.push(lockDirOf(this));
      const release = vi.fn(async () => undefined);
      return {
        path: "C:/profiles/accounts/.locks/account-main.lock",
        release,
        [Symbol.asyncDispose]: release,
      };
    });
    vi.spyOn(CompatibilityGuard.prototype, "verify").mockResolvedValue({
      buildId: "8dd50222",
      assets: [{ filename: "bundle.js" }, { filename: "bootstrap.js" }],
    } as never);
    vi.spyOn(SealedSessionStore.prototype, "write").mockImplementation(async function (this: SealedSessionStore) {
      persistedPaths.push(this.path);
    });

    await expect(runSessionImport(["private/export.json"], output.value, {
      config: selected,
    } as never)).resolves.toBe(0);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(sessionLoaderModule.loadSession).toHaveBeenCalledWith("private/export.json");
    expect(acquiredLockDirs).toEqual([selected.lockDir]);
    expect(persistedPaths).toEqual([selected.sessionFile]);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "session.imported",
      buildId: "8dd50222",
      assetCount: 2,
    });
  });

  it("rejects a session for another selected account before writing", async () => {
    const output = io();
    const write = vi.spyOn(SealedSessionStore.prototype, "write");
    vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(sessionLoaderModule, "loadSession").mockResolvedValue(session({
      accountId: "other-account",
    }) as never);

    await expect(runSessionImport(["private/export.json"], output.value, {
      config: config(),
    } as never)).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    expect(write).not.toHaveBeenCalled();
  });

  it("imports one validated export and prints only a safe summary", async () => {
    const output = io();
    const importSession = vi.fn(async () => ({ buildId: "8dd50222" as const, assetCount: 4 }));

    await expect(runSessionImport(["private/export.json"], output.value, {
      importSession,
      output: "json",
    })).resolves.toBe(0);

    expect(importSession).toHaveBeenCalledWith("private/export.json");
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "session.imported",
      buildId: "8dd50222",
      assetCount: 4,
    });
  });

  it("rejects missing or extra paths before reading a session", async () => {
    const output = io();
    const importSession = vi.fn();
    await expect(runSessionImport([], output.value, { importSession })).resolves.toBe(2);
    await expect(runSessionImport(["a", "b"], output.value, { importSession })).resolves.toBe(2);
    expect(importSession).not.toHaveBeenCalled();
  });
});
