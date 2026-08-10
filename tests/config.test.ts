import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";

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
});
