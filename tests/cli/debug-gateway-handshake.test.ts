import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import { runDebugGatewayHandshake } from "../../src/cli/commands/debug-gateway-handshake.js";
import type { CliIo } from "../../src/cli/io.js";
import * as configModule from "../../src/config.js";
import * as sessionLoaderModule from "../../src/session/loader.js";

function io(): { readonly value: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      version: "test",
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
      gatewayToken: "gateway-secret",
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

describe("debug gateway-handshake", () => {
  it("requires explicit live-test opt-in before loading credentials", async () => {
    const output = io();
    await expect(runDebugGatewayHandshake([], output.value, { env: {} }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(output.stdout).toEqual([]);
  });

  it("uses the injected selected config instead of the legacy environment", async () => {
    const output = io();
    const selected = config();
    const loadConfig = vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("legacy config should not be read");
    });
    vi.spyOn(configModule, "loadEnvironmentFile").mockImplementation(() => undefined);
    vi.spyOn(sessionLoaderModule, "loadSession").mockResolvedValue(session() as never);

    const code = await runDebugGatewayHandshake(["--json"], output.value, {
      config: selected,
      env: { SNAP_LIVE_TESTS: "1" },
      probe: async (token: string) => {
        expect(token).toBe("gateway-secret");
        return {
          status: 401,
          classification: "authorization-rejected" as const,
          protocol: "none" as const,
          headerNames: ["server"],
          durationMs: 3,
        };
      },
    } as never);

    expect(code).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(sessionLoaderModule.loadSession).toHaveBeenCalledWith(selected.sessionFile);
  });

  it("prints only safe handshake metadata", async () => {
    const output = io();
    const session = {
      accountId: "account-1",
      buildId: "8dd50222" as const,
      auth: { gatewayToken: "gateway-secret" },
    };
    const code = await runDebugGatewayHandshake(["--json"], output.value, {
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
      },
      loadSession: async () => session as never,
      probe: async (token) => {
        expect(token).toBe("gateway-secret");
        return {
          status: 401,
          classification: "authorization-rejected" as const,
          protocol: "none" as const,
          headerNames: ["server"],
          durationMs: 3,
        };
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "debug.gateway-handshake",
      status: 401,
      classification: "authorization-rejected",
      protocol: "none",
      headerNames: ["server"],
      durationMs: 3,
    });
    expect(output.stdout.join("\n")).not.toContain("gateway-secret");
  });
});
