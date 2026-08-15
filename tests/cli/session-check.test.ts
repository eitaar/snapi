import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import {
  assertSessionCheckBuild,
  runSessionCheck,
} from "../../src/cli/commands/session-check.js";
import * as configModule from "../../src/config.js";
import { CompatibilityGuard } from "../../src/compat/guard.js";
import { AppError } from "../../src/errors.js";
import { AccountLock } from "../../src/session/account-lock.js";
import * as sessionLoaderModule from "../../src/session/loader.js";

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

describe("session check command", () => {
  it("rejects a session build that differs from the configured build", () => {
    expect(() => assertSessionCheckBuild("8dd50222", "da4d065e")).toThrowError(AppError);
  });

  it("uses the injected profile session and lock root instead of legacy config", async () => {
    const stdout: string[] = [];
    const selected = config();
    const inspectedLockDirs: string[] = [];
    const loadConfig = vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(sessionLoaderModule, "loadSession").mockResolvedValue(session() as never);
    vi.spyOn(AccountLock.prototype, "inspect").mockImplementation(async function (this: object) {
      inspectedLockDirs.push(lockDirOf(this));
      return undefined;
    });
    vi.spyOn(CompatibilityGuard.prototype, "verify").mockResolvedValue({
      buildId: "8dd50222",
      assets: [{ filename: "bundle.js" }, { filename: "bootstrap.js" }],
    } as never);

    const code = await runSessionCheck(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { config: selected } as never,
    );

    expect(code).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(sessionLoaderModule.loadSession).toHaveBeenCalledWith(selected.sessionFile);
    expect(inspectedLockDirs).toEqual([selected.lockDir]);
    expect(JSON.parse(stdout[0]!)).toEqual({
      type: "session.checked",
      buildId: "8dd50222",
      assetCount: 2,
    });
  });

  it("prints only a safe validation summary", async () => {
    const stdout: string[] = [];
    const inspect = vi.fn(async () => ({ buildId: "8dd50222" as const, assetCount: 4 }));
    const code = await runSessionCheck(
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { inspect, output: "json" },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({ type: "session.checked", buildId: "8dd50222", assetCount: 4 });
    expect(inspect).toHaveBeenCalledOnce();
  });
});
