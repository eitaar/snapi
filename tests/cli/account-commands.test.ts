import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { AppConfig } from "../../src/config.js";
import { main } from "../../src/cli/index.js";
import { runAccountAdd } from "../../src/cli/commands/account-add.js";
import { runAccountList } from "../../src/cli/commands/account-list.js";
import { runAccountShow } from "../../src/cli/commands/account-show.js";

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

const resolvedConfig: AppConfig = {
  sessionFile: "C:/profiles/main-session.json",
  assetDir: "C:/profiles/main-assets",
  lockDir: "C:/profiles/accounts/.locks",
  accountId: "account-1",
  buildId: "8dd50222",
  output: "json",
};

describe("account add", () => {
  it("derives identity and never prints the account id", async () => {
    const output = io();
    const add = vi.fn(async () => ({
      alias: "main",
      buildId: "da4d065e" as const,
      status: "ready" as const,
    }));

    const code = await runAccountAdd([
      "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
    ], output.value, { add });

    expect(code).toBe(0);
    expect(add).toHaveBeenCalledWith("main", {
      sessionFile: "private/main.json",
      assetDir: "private/da4d-assets",
    });
    expect(output.stdout.join("\n")).toBe("Account added: main (da4d065e, ready)");
    expect(output.stdout.join("\n")).not.toContain("11111111-2222-4333-8444-555555555555");
  });

  it("rejects a duplicate alias", async () => {
    const output = io();

    await expect(runAccountAdd([
      "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
    ], output.value, {
      add: async () => {
        throw new AppError("INVALID_CONFIG", "Account alias already exists", { alias: "main" });
      },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("fails closed when the session export is missing", async () => {
    const output = io();
    const storeAdd = vi.fn();

    await expect(runAccountAdd([
      "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
    ], output.value, {
      cwd: "C:/repo",
      store: { add: storeAdd },
      loadSession: async () => {
        throw new AppError("INVALID_SESSION_EXPORT", "Unable to read session export");
      },
    })).rejects.toMatchObject({ code: "INVALID_SESSION_EXPORT" });

    expect(storeAdd).not.toHaveBeenCalled();
  });

  it("rejects an unsupported build before writing the profile", async () => {
    const output = io();
    const storeAdd = vi.fn();
    const verifyCompatibility = vi.fn();

    await expect(runAccountAdd([
      "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
    ], output.value, {
      cwd: "C:/repo",
      store: { add: storeAdd },
      verifyCompatibility,
      loadSession: async () => ({
        formatVersion: 1,
        accountId: "11111111-2222-4333-8444-555555555555",
        buildId: "future-build" as never,
        exportedAt: "2026-08-14T00:00:00.000Z",
        auth: { httpToken: "token", gatewayToken: "token", cookieHeader: "cookie", requestHeaders: {} },
        assets: [],
        localStorage: {},
        indexedDb: { databases: [] },
      }),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });

    expect(verifyCompatibility).not.toHaveBeenCalled();
    expect(storeAdd).not.toHaveBeenCalled();
  });

  it("stops before persisting the profile when asset verification fails", async () => {
    const output = io();
    const storeAdd = vi.fn();

    await expect(runAccountAdd([
      "main", "--session", "private/main.json", "--asset-dir", "private/da4d-assets",
    ], output.value, {
      cwd: "C:/repo",
      store: { add: storeAdd },
      loadSession: async () => ({
        formatVersion: 1,
        accountId: "11111111-2222-4333-8444-555555555555",
        buildId: "da4d065e",
        exportedAt: "2026-08-14T00:00:00.000Z",
        auth: { httpToken: "token", gatewayToken: "token", cookieHeader: "cookie", requestHeaders: {} },
        assets: [],
        localStorage: {},
        indexedDb: { databases: [] },
      }),
      verifyCompatibility: async () => {
        throw new AppError("UNSUPPORTED_BUILD", "Build asset verification failed", { filename: "main.js" });
      },
    })).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });

    expect(storeAdd).not.toHaveBeenCalled();
  });
});

describe("account list", () => {
  it("emits only alias build and status", async () => {
    const output = io();

    const code = await runAccountList(["--json"], output.value, {
      output: "json",
      list: async () => [{ alias: "main", buildId: "da4d065e", status: "ready" }],
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "accounts.list",
      accounts: [{ alias: "main", buildId: "da4d065e", status: "ready" }],
    });
    expect(output.stdout.join("\n")).not.toContain("sessionFile");
    expect(output.stdout.join("\n")).not.toContain("assetDir");
  });

  it("maps a session that disappears before loading to missing-session", async () => {
    const output = io();

    const code = await runAccountList(["--json"], output.value, {
      output: "json",
      store: {
        list: async () => [{ alias: "main", status: "ready" }],
        read: async () => ({
          alias: "main",
          sessionFile: "C:/repo/private/main.json",
          assetDir: "C:/repo/private/da4d-assets",
        }),
      },
      loadSession: async () => {
        throw Object.assign(new Error("session disappeared"), { code: "ENOENT" });
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "accounts.list",
      accounts: [{ alias: "main", status: "missing-session" }],
    });
  });
});

describe("account show", () => {
  it("shows one account in human output with non-secret paths only", async () => {
    const output = io();

    const code = await runAccountShow(["main"], output.value, {
      show: async () => ({
        alias: "main",
        buildId: "da4d065e",
        status: "ready",
        sessionFile: "C:/repo/private/main.json",
        assetDir: "C:/repo/private/da4d-assets",
      }),
    });

    expect(code).toBe(0);
    expect(output.stdout).toEqual([
      "Account: main",
      "Status: ready",
      "Build: da4d065e",
      "Session: C:/repo/private/main.json",
      "Assets: C:/repo/private/da4d-assets",
    ]);
  });

  it("shows one account in json output", async () => {
    const output = io();

    const code = await runAccountShow(["main", "--json"], output.value, {
      output: "json",
      show: async () => ({
        alias: "main",
        buildId: "da4d065e",
        status: "ready",
        sessionFile: "C:/repo/private/main.json",
        assetDir: "C:/repo/private/da4d-assets",
      }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "accounts.show",
      account: {
        alias: "main",
        buildId: "da4d065e",
        status: "ready",
        sessionFile: "C:/repo/private/main.json",
        assetDir: "C:/repo/private/da4d-assets",
      },
    });
  });

  it("rejects an unknown alias", async () => {
    const output = io();

    await expect(runAccountShow(["main"], output.value, {
      show: async () => {
        throw new AppError("INVALID_CONFIG", "Account profile does not exist", { alias: "main" });
      },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});

describe("account command routing", () => {
  it("routes account commands before profile config resolution and passes SNAAPI_ACCOUNTS_DIR", async () => {
    const output = io();
    const resolveConfig = vi.fn(async () => resolvedConfig);
    const runAccountListRoute = vi.fn(async () => 0);

    const code = await main(["account", "list"], output.value, {
      env: { SNAAPI_ACCOUNTS_DIR: "C:/custom/accounts" },
      resolveConfig,
      runAccountList: runAccountListRoute,
    });

    expect(code).toBe(0);
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(runAccountListRoute).toHaveBeenCalledWith([], output.value, {
      accountsDir: "C:/custom/accounts",
      env: { SNAAPI_ACCOUNTS_DIR: "C:/custom/accounts" },
      output: "human",
    });
  });

  it("routes account management despite an invalid SNAAPI_ACCOUNT", async () => {
    const output = io();
    const resolveConfig = vi.fn(async () => resolvedConfig);
    const runAccountListRoute = vi.fn(async () => 0);

    const code = await main(["account", "list"], output.value, {
      env: { SNAAPI_ACCOUNT: "../invalid" },
      resolveConfig,
      runAccountList: runAccountListRoute,
    });

    expect(code).toBe(0);
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(runAccountListRoute).toHaveBeenCalledWith([], output.value, {
      env: { SNAAPI_ACCOUNT: "../invalid" },
      output: "human",
    });
  });

  it.each(["main", "../invalid"])(
    "routes account management before validating explicit --account %s",
    async (accountAlias) => {
      const output = io();
      const resolveConfig = vi.fn(async () => resolvedConfig);
      const runAccountListRoute = vi.fn(async () => 0);

      const code = await main(["--account", accountAlias, "account", "list"], output.value, {
        env: { SNAAPI_ACCOUNT: "../invalid-env" },
        resolveConfig,
        runAccountList: runAccountListRoute,
      });

      expect(code).toBe(0);
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(runAccountListRoute).toHaveBeenCalledWith([], output.value, {
        env: { SNAAPI_ACCOUNT: "../invalid-env" },
        output: "human",
      });
    },
  );
});
