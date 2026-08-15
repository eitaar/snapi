import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import { AuthProvider } from "../../src/transport/auth-provider.js";
import {
  assertGatewayRuntimeBuild,
  createConfiguredGatewayStatusClient,
} from "../../src/cli/gateway-status-client.js";
import * as configModule from "../../src/config.js";
import { AccountLock } from "../../src/session/account-lock.js";
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

function lockDirOf(value: object): string {
  return (value as Record<string, unknown>).lockDirectory as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway runtime build guard", () => {
  it("allows the verified da4d065e runtime build", () => {
    expect(() => assertGatewayRuntimeBuild("da4d065e")).not.toThrow();
  });

  it("allows the verified 8dd50222 runtime build", () => {
    expect(() => assertGatewayRuntimeBuild("8dd50222")).not.toThrow();
  });

  it("uses the injected profile session and lock root instead of legacy config", async () => {
    const selected = config();
    const acquiredLockDirs: string[] = [];
    const sessionPaths: string[] = [];
    const loadConfig = vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(SealedSessionStore.prototype, "readOrMigrateLegacy").mockImplementation(async function (this: SealedSessionStore) {
      sessionPaths.push(this.path);
      return session();
    });
    vi.spyOn(AccountLock.prototype, "acquire").mockImplementation(async function (this: object) {
      acquiredLockDirs.push(lockDirOf(this));
      const release = vi.fn(async () => undefined);
      return {
        path: "C:/profiles/accounts/.locks/account-main.lock",
        release,
        [Symbol.asyncDispose]: release,
      };
    });
    vi.spyOn(AuthProvider.prototype, "getRequestAuth").mockResolvedValue({
      httpToken: "http-token",
      cookieHeader: "cookie=secret",
      requestHeaders: {},
    } as never);

    const configured = await createConfiguredGatewayStatusClient(selected as never);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(sessionPaths).toEqual([selected.sessionFile]);
    expect(acquiredLockDirs).toEqual([selected.lockDir]);
    expect(configured.output).toBe("json");
    await configured.client.close();
  });
});
