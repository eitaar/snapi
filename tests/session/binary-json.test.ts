import { describe, expect, it } from "vitest";
import {
  parseJsonWithBytes,
  stringifyJsonWithBytes,
} from "../../src/session/binary-json.js";

describe("binary JSON", () => {
  it("round-trips nested Uint8Array values through canonical Base64 tags", () => {
    const text = stringifyJsonWithBytes({
      key: new Uint8Array([0, 1, 255]),
      nested: [new Uint8Array([2, 3])],
    });

    expect(JSON.parse(text)).toEqual({
      key: { $bytes: "AAH/" },
      nested: [{ $bytes: "AgM=" }],
    });
    expect(parseJsonWithBytes(text)).toEqual({
      key: new Uint8Array([0, 1, 255]),
      nested: [new Uint8Array([2, 3])],
    });
  });

  it("rejects malformed byte tags instead of silently changing key state", () => {
    expect(() => parseJsonWithBytes('{"$bytes":"not base64!"}')).toThrow("Base64");
    expect(() => parseJsonWithBytes('{"$bytes":"AQID","extra":true}')).not.toThrow();
  });
});

  it("encodes ArrayBuffer values and rejects a non-serializable root", () => {
    const buffer = Uint8Array.from([4, 5]).buffer;
    expect(parseJsonWithBytes(stringifyJsonWithBytes({ buffer }))).toEqual({
      buffer: new Uint8Array([4, 5]),
    });
    expect(() => stringifyJsonWithBytes(undefined)).toThrow("serializable");
  });
