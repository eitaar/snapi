import { describe, expect, it } from "vitest";
import { redact } from "../../src/logging/redact.js";

describe("redact", () => {
  it("recursively removes secret-keyed values while preserving safe data", () => {
    const input = {
      authorization: "Bearer secret",
      nested: {
        cookieHeader: "sc-a=secret",
        accessToken: "token",
        signature: "signature",
        signed_url: "https://cdn.invalid/?sig=secret",
        cryptoState: { key: "secret" },
        imageBytes: new Uint8Array([1, 2, 3]),
        plaintext: "private message",
        safe: ["ok", { value: 7 }],
      },
    };

    expect(redact(input)).toEqual({
      authorization: "<REDACTED>",
      nested: {
        cookieHeader: "<REDACTED>",
        accessToken: "<REDACTED>",
        signature: "<REDACTED>",
        signed_url: "<REDACTED>",
        cryptoState: "<REDACTED>",
        imageBytes: "<REDACTED>",
        plaintext: "<REDACTED>",
        safe: ["ok", { value: 7 }],
      },
    });
  });
});
