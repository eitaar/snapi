import { describe, expect, it } from "vitest";
import { parseGlobalCliOptions } from "../../src/cli/global-options.js";

describe("parseGlobalCliOptions", () => {
  it("strips an explicit account prefix and gives it precedence", () => {
    expect(parseGlobalCliOptions(
      ["--account", "bot", "chat", "send", "recipient", "hello"],
      { SNAAPI_ACCOUNT: "main" },
    )).toEqual({
      accountAlias: "bot",
      argv: ["chat", "send", "recipient", "hello"],
    });
  });

  it("uses the per-shell default without changing command arguments", () => {
    expect(parseGlobalCliOptions(
      ["friends", "list", "--easy"],
      { SNAAPI_ACCOUNT: "main" },
    )).toEqual({
      accountAlias: "main",
      argv: ["friends", "list", "--easy"],
    });
  });

  it("rejects a missing or unsafe explicit alias and an unsafe environment alias", () => {
    expect(() => parseGlobalCliOptions(["--account"], {})).toThrowError(/account/i);
    expect(() => parseGlobalCliOptions(["--account", "../main", "friends", "list"], {}))
      .toThrowError(/alias/i);
    expect(() => parseGlobalCliOptions(["friends", "list"], { SNAAPI_ACCOUNT: "../main" }))
      .toThrowError(/alias/i);
  });

  it("leaves --account after the command in subcommand argv", () => {
    expect(parseGlobalCliOptions(
      ["friends", "list", "--account", "bot"],
      { SNAAPI_ACCOUNT: "main" },
    )).toEqual({
      accountAlias: "main",
      argv: ["friends", "list", "--account", "bot"],
    });
  });
});
