import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { loadConfig, loadEnvironmentFile } from "../src/config.js";

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
      accountId: "account-1",
      buildId: "8dd50222",
      output: "json",
    });
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

  it("allows a missing optional environment file", () => {
    expect(() => loadEnvironmentFile("definitely-missing-test.env")).not.toThrow();
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
    expect(() => loadConfig({
      SNAP_SESSION_FILE: "session.json",
      SNAP_ASSET_DIR: "assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_COOKIE_HEADER: "web=session\r\nX-Injected: yes",
    })).toThrowError(AppError);
  });
});

  it("defaults to human output", () => {
    expect(loadConfig({
      SNAP_SESSION_FILE: "session.json",
      SNAP_ASSET_DIR: "assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
    }).output).toBe("human");
  });

  it("rejects an invalid output mode", () => {
    expect(() => loadConfig({
      SNAP_SESSION_FILE: "session.json",
      SNAP_ASSET_DIR: "assets",
      SNAP_ACCOUNT_ID: "account-1",
      SNAP_BUILD_ID: "8dd50222",
      SNAP_OUTPUT: "xml",
    })).toThrowError(AppError);
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
