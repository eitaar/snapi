import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { loadConfig, loadEnvironmentFile, resolveAppConfig } from "../src/config.js";
import type { SessionExport } from "../src/session/types.js";

describe("loadConfig", () => {
  it("returns only normalized configuration fields", () => {
    const config = loadConfig({
      SNAP_SESSION_FILE: "./private/session.json",
      SNAP_ASSET_DIR: "./private/assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_OUTPUT: "json",
      UNRELATED_SECRET: "must-not-leak",
    });

    expect(isAbsolute(config.sessionFile)).toBe(true);
    expect(isAbsolute(config.assetDir)).toBe(true);
    expect(config).toEqual({
      sessionFile: expect.any(String),
      assetDir: expect.any(String),
      lockDir: expect.any(String),
      accountId: "account-1",
      buildId: "8dd50222",
      output: "json",
    });
    expect(config.lockDir).toBe(join(resolve("./private"), "locks"));
  });

  it("fails closed for an unsupported build", () => {
    expect(() =>
      loadConfig({
        SNAP_SESSION_FILE: "session.json",
        SNAP_ASSET_DIR: "assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "other",
      }),
    ).toThrowError(AppError);
  });

  it("accepts the explicitly selected da4d065e build", () => {
    expect(
      loadConfig({
        SNAP_SESSION_FILE: "session.json",
        SNAP_ASSET_DIR: "assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "da4d065e",
      }).buildId,
    ).toBe("da4d065e");
  });

  it("defaults to human output", () => {
    expect(
      loadConfig({
        SNAP_SESSION_FILE: "session.json",
        SNAP_ASSET_DIR: "assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
      }).output,
    ).toBe("human");
  });

  it("rejects an invalid output mode", () => {
    expect(() =>
      loadConfig({
        SNAP_SESSION_FILE: "session.json",
        SNAP_ASSET_DIR: "assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_OUTPUT: "xml",
      }),
    ).toThrowError(AppError);
  });

  it("rejects each missing required setting", () => {
    const complete = {
      SNAP_SESSION_FILE: "session.json",
      SNAP_ASSET_DIR: "assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
    };
    for (const name of Object.keys(complete)) {
      const env = { ...complete } as Record<string, string | undefined>;
      delete env[name];
      expect(() => loadConfig(env)).toThrowError(AppError);
    }
  });

  it("loads optional browser cookie headers without requiring them", () => {
    const config = loadConfig({
      SNAP_SESSION_FILE: "session.json",
      SNAP_ASSET_DIR: "assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_COOKIE_HEADER: "  web=session; sc_at=token  ",
      SNAP_SSO_COOKIE_HEADER: " accounts=session; __Host-sc-a-auth-session=token ",
    });

    expect(config.cookieHeader).toBe("web=session; sc_at=token");
    expect(config.ssoCookieHeader).toBe("accounts=session; __Host-sc-a-auth-session=token");
  });

  it("rejects browser cookie headers containing line breaks", () => {
    expect(() =>
      loadConfig({
        SNAP_SESSION_FILE: "session.json",
        SNAP_ASSET_DIR: "assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_COOKIE_HEADER: "web=session\r\nX-Injected: yes",
      }),
    ).toThrowError(AppError);
  });

  it("allows a missing optional environment file", () => {
    expect(() => loadEnvironmentFile("definitely-missing-test.env")).not.toThrow();
  });
});

describe("resolveAppConfig", () => {
  it("derives profile identity from its sealed session metadata", async () => {
    const config = await resolveAppConfig(
      { accountAlias: "main", env: { SNAP_OUTPUT: "json" } },
      {
        accountsDir: "C:/repo/private/accounts",
        readProfile: async () => ({
          alias: "main",
          sessionFile: "C:/repo/private/main-session.json",
          assetDir: "C:/repo/private/da4d-assets",
        }),
        loadSession: async () => ({
          formatVersion: 1,
          accountId: "11111111-2222-4333-8444-555555555555",
          buildId: "da4d065e",
          exportedAt: "2026-08-14T00:00:00.000Z",
          auth: {
            httpToken: "token",
            gatewayToken: "gateway",
            tokenRefreshedAt: "2026-08-14T00:00:00.000Z",
            cookieHeader: "web=session",
            ssoCookieHeader: "sso=session",
            requestHeaders: {},
          },
          assets: [],
          localStorage: {},
          sessionStorage: {},
          indexedDb: { databases: [] },
        }),
      },
    );

    expect(config).toMatchObject({
      accountAlias: "main",
      accountId: "11111111-2222-4333-8444-555555555555",
      buildId: "da4d065e",
      sessionFile: "C:/repo/private/main-session.json",
      assetDir: "C:/repo/private/da4d-assets",
      lockDir: join("C:/repo/private/accounts", ".locks"),
      output: "json",
    });
  });

  it("returns the shared profile lock root and validated account alias", async () => {
    const config = await resolveAppConfig(
      { accountAlias: "main", cwd: "C:/workspace" },
      {
        readProfile: async (alias) => ({
          alias,
          sessionFile: "C:/workspace/private/main-session.json",
          assetDir: "C:/workspace/private/da4d-assets",
        }),
        loadSession: async () => ({
          formatVersion: 1,
          accountId: "account-1",
          buildId: "8dd50222",
          exportedAt: "2026-08-14T00:00:00.000Z",
          auth: {
            httpToken: "token",
            gatewayToken: "gateway",
            tokenRefreshedAt: "2026-08-14T00:00:00.000Z",
            cookieHeader: "web=session",
            ssoCookieHeader: "sso=session",
            requestHeaders: {},
          },
          assets: [],
          localStorage: {},
          sessionStorage: {},
          indexedDb: { databases: [] },
        }),
      },
    );

    expect(config.accountAlias).toBe("main");
    expect(config.lockDir).toBe(join("C:/workspace/private/accounts", ".locks"));
  });

  it("ignores legacy path account and build variables in profile mode", async () => {
    const config = await resolveAppConfig(
      {
        accountAlias: "main",
        env: {
          SNAP_SESSION_FILE: "C:/wrong/session.json",
          SNAP_ASSET_DIR: "C:/wrong/assets",
          SNAP_ACCOUNT_ID: "wrong-account",
          SNAP_BUILD_ID: "8dd50222",
        },
      },
      {
        accountsDir: "C:/repo/private/accounts",
        readProfile: async () => ({
          alias: "main",
          sessionFile: "C:/repo/private/right-session.json",
          assetDir: "C:/repo/private/right-assets",
        }),
        loadSession: async () => ({
          formatVersion: 1,
          accountId: "right-account",
          buildId: "da4d065e",
          exportedAt: "2026-08-14T00:00:00.000Z",
          auth: {
            httpToken: "token",
            gatewayToken: "gateway",
            tokenRefreshedAt: "2026-08-14T00:00:00.000Z",
            cookieHeader: "profile-web-cookie",
            ssoCookieHeader: "profile-sso-cookie",
            requestHeaders: {},
          },
          assets: [],
          localStorage: {},
          sessionStorage: {},
          indexedDb: { databases: [] },
        }),
      },
    );

    expect(config).toMatchObject({
      sessionFile: "C:/repo/private/right-session.json",
      assetDir: "C:/repo/private/right-assets",
      accountId: "right-account",
      buildId: "da4d065e",
    });
  });

  it("applies only output and cookie overrides in profile mode", async () => {
    const config = await resolveAppConfig(
      {
        accountAlias: "main",
        env: {
          SNAP_OUTPUT: "json",
          SNAP_COOKIE_HEADER: " override-web-cookie ",
          SNAP_SSO_COOKIE_HEADER: " override-sso-cookie ",
        },
      },
      {
        accountsDir: "C:/repo/private/accounts",
        readProfile: async () => ({
          alias: "main",
          sessionFile: "C:/repo/private/main-session.json",
          assetDir: "C:/repo/private/da4d-assets",
        }),
        loadSession: async () => ({
          formatVersion: 1,
          accountId: "account-1",
          buildId: "8dd50222",
          exportedAt: "2026-08-14T00:00:00.000Z",
          auth: {
            httpToken: "token",
            gatewayToken: "gateway",
            tokenRefreshedAt: "2026-08-14T00:00:00.000Z",
            cookieHeader: "profile-web-cookie",
            ssoCookieHeader: "profile-sso-cookie",
            requestHeaders: {},
          },
          assets: [],
          localStorage: {},
          sessionStorage: {},
          indexedDb: { databases: [] },
        }),
      },
    );

    expect(config.output).toBe("json");
    expect(config.cookieHeader).toBe("override-web-cookie");
    expect(config.ssoCookieHeader).toBe("override-sso-cookie");
  });

  it("keeps legacy configuration when no alias is selected", async () => {
    const config = await resolveAppConfig({
      env: {
        SNAP_SESSION_FILE: "./private/session.json",
        SNAP_ASSET_DIR: "./private/assets",
        SNAP_ACCOUNT_ID: "account-1",
        SNAP_BUILD_ID: "8dd50222",
      },
    });

    expect(config.accountAlias).toBeUndefined();
    expect(config.sessionFile).toBe(resolve("private/session.json"));
    expect(config.assetDir).toBe(resolve("private/assets"));
    expect(config.lockDir).toBe(resolve("private/locks"));
  });

  it("rejects an unsupported build from the selected profile session", async () => {
    await expect(
      resolveAppConfig(
        { accountAlias: "main" },
        {
          readProfile: async () => ({
            alias: "main",
            sessionFile: "C:/repo/private/main-session.json",
            assetDir: "C:/repo/private/da4d-assets",
          }),
          loadSession: async () => ({
            formatVersion: 1,
            accountId: "account-1",
            buildId: "unsupported-build",
            exportedAt: "2026-08-14T00:00:00.000Z",
            auth: {
              httpToken: "token",
              gatewayToken: "gateway",
              tokenRefreshedAt: "2026-08-14T00:00:00.000Z",
              cookieHeader: "web=session",
              ssoCookieHeader: "sso=session",
              requestHeaders: {},
            },
            assets: [],
            localStorage: {},
            sessionStorage: {},
            indexedDb: { databases: [] },
          } as unknown as SessionExport),
        },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });
});
