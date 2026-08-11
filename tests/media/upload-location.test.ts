import { describe, expect, it } from "vitest";
import {
  encodeGetUploadLocationsRequest,
  parseUploadLocation,
} from "../../src/media/upload-location.js";
import { concatBytes, writeBytesField, writeStringField, writeVarintField } from "../../src/wire/protobuf.js";

describe("media upload location codec", () => {
  it("encodes the exact observed direct-upload request", () => {
    expect(encodeGetUploadLocationsRequest()).toEqual(concatBytes(
      writeVarintField(2, 1),
      writeVarintField(4, 1),
      writeBytesField(7, new Uint8Array([0])),
      writeVarintField(16, 1),
    ));
  });

  it("parses one signed CDN URL and nested content object", () => {
    const contentObject = new Uint8Array([8, 9, 10]);
    const location = concatBytes(
      writeStringField(1, "https://cf-st.sc-cdn.net/r/signed-secret"),
      writeBytesField(2, writeVarintField(1, 1_786_586_317)),
      writeBytesField(3, writeVarintField(1, 86_400)),
      writeBytesField(4, concatBytes(
        writeBytesField(3, contentObject),
        writeVarintField(5, 1),
      )),
    );

    expect(parseUploadLocation(writeBytesField(1, location))).toEqual({
      uploadUrl: "https://cf-st.sc-cdn.net/r/signed-secret",
      expiresAtSeconds: 1_786_586_317,
      postSuccessValiditySeconds: 86_400,
      contentObject,
    });
  });

  it("rejects missing, ambiguous, and non-Snap CDN locations", () => {
    expect(() => parseUploadLocation(new Uint8Array())).toThrow("exactly one");
    expect(() => parseUploadLocation(concatBytes(
      writeBytesField(1, new Uint8Array()),
      writeBytesField(1, new Uint8Array()),
    ))).toThrow("exactly one");
    expect(() => parseUploadLocation(writeBytesField(1, concatBytes(
      writeStringField(1, "https://evil.example/upload"),
      writeBytesField(4, writeBytesField(3, new Uint8Array([1]))),
    )))).toThrow("Snap CDN");
  });
});
