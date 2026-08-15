import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";
import { runSessionExportCdp } from "../../src/cli/commands/session-export-cdp.js";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";
import * as browserModule from "../../src/browser/cdp.js";
import { CompatibilityGuard } from "../../src/compat/guard.js";
import * as browserExportModule from "../../src/session/browser-export.js";
import * as harBuildModule from "../../src/session/har-build.js";
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

function exportedSession(overrides: Partial<SessionExport> = {}): SessionExport {
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
    sessionStorage: {},
    messaging: {
      rootWrappingKey: { data: "wrapped", identityKeyId: "identity-key" },
      friendDevices: {},
    },
    indexedDb: { databases: [] },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session export-cdp", () => {
  it("rejects a profile output path that does not match the selected session file", async () => {
    const output = io();
    const write = vi.spyOn(SealedSessionStore.prototype, "write");
    const capture = vi.spyOn(browserModule, "captureBrowserState").mockResolvedValue({
      pageUrl: "https://web.snapchat.com/",
      localStorage: {},
      sessionStorage: {},
      indexedDb: { databases: [] },
    });
    vi.spyOn(harBuildModule, "detectHarBuildId").mockReturnValue("8dd50222");
    vi.spyOn(browserExportModule, "createSessionExport").mockReturnValue(exportedSession());
    vi.spyOn(CompatibilityGuard.prototype, "verify").mockResolvedValue({
      buildId: "8dd50222",
      assets: [{ filename: "bundle.js" }],
    } as never);

    await expect(runSessionExportCdp([
      "--har", "private/fresh.har",
      "--output", "C:/profiles/other-session.json",
    ], output.value, {
      config: config(),
      readFile: async () => Buffer.from("{}"),
      env: {
        SNAP_BUILD_ID: "8dd50222",
        SNAP_ASSET_DIR: "C:/legacy/assets",
      },
    } as never)).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    expect(capture).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("routes the command without echoing session credentials", async () => {
    const output = io();
    const selected = config();
    const resolveConfig = vi.fn(async (accountAlias?: string) => {
      expect(accountAlias).toBe("main");
      return selected;
    });
    const run = vi.fn(async (
      argv: readonly string[],
      commandIo: CliIo,
      dependencies?: { readonly config?: AppConfig },
    ) => {
      expect(argv).toEqual(["--har", "private/fresh.har", "--output", "private/export.json"]);
      expect(dependencies?.config).toBe(selected);
      commandIo.stdout(JSON.stringify({ type: "session.exported", buildId: "da4d065e", assetCount: 4 }));
      return 0;
    });

    const code = await main([
      "--account", "main",
      "session", "export-cdp", "--har", "private/fresh.har", "--output", "private/export.json",
    ], output.value, { resolveConfig, runSessionExportCdp: run } as never);

    expect(code).toBe(0);
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(output.stdout.join("\n")).not.toContain("Bearer");
    expect(output.stderr).toEqual([]);
  });
});
