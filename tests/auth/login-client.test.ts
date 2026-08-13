import { describe, expect, it } from "vitest";
import { createLoginTransport } from "../../src/auth/login-client.js";

describe("login client contract guard", () => {
  it("refuses to submit credentials without a verified pinned WebLogin contract", () => {
    expect(() => createLoginTransport()).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_BUILD" }),
    );
  });
});
