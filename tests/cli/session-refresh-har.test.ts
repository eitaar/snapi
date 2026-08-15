import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import {
  assertSessionRefreshBuild,
  runSessionRefreshHar,
} from "../../src/cli/commands/session-refresh-har.js";
import * as configModule from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import * as sessionLoaderModule from "../../src/session/loader.js";
import { SealedSessionStore } from "../../src/session/sealed-store.js";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session refresh-har command", () => {
  it("rejects a session build that differs from the configured build", () => {
    expect(() => assertSessionRefreshBuild("8dd50222", "da4d065e")).toThrowError(AppError);
  });

  it("rejects a mismatched selected build before reading the HAR or persisting", async () => {
    const output = { version: "0.1.0", stdout: () => undefined, stderr: () => undefined };
    const write = vi.spyOn(SealedSessionStore.prototype, "write");
    vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(sessionLoaderModule, "loadSession").mockResolvedValue(session({
      buildId: "da4d065e",
    }) as never);

    await expect(runSessionRefreshHar(["private/fresh.har"], output, {
      config: config(),
    } as never)).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });

    expect(write).not.toHaveBeenCalled();
  });

  it("imports, refreshes, and atomically persists before printing a safe summary", async () => {
    const stdout: string[] = [];
    const execute = vi.fn(async () => ({ buildId: "8dd50222" as const, refreshedAt: "2026-08-11T04:00:00.000Z" }));
    const code = await runSessionRefreshHar(
      ["private/fresh.har"],
      { version: "0.1.0", stdout: (line) => stdout.push(line), stderr: () => undefined },
      { execute, output: "json" },
    );
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledWith("private/fresh.har");
    expect(JSON.parse(stdout[0]!)).toEqual({
      type: "session.refreshed",
      buildId: "8dd50222",
      refreshedAt: "2026-08-11T04:00:00.000Z",
    });
  });

  it("rejects extra arguments before reading secrets", async () => {
    const stderr: string[] = [];
    const execute = vi.fn();
    await expect(runSessionRefreshHar(
      ["one.har", "two.har"],
      { version: "0.1.0", stdout: () => undefined, stderr: (line) => stderr.push(line) },
      { execute },
    )).resolves.toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
