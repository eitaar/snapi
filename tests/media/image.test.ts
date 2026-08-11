import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, validatePhoto } from "../../src/media/image.js";

function png(width = 3, height = 2): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    width >>> 24, width >>> 16, width >>> 8, width,
    height >>> 24, height >>> 16, height >>> 8, height,
    8, 6, 0, 0, 0,
  ]);
}

function jpeg(width = 3, height = 2): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >>> 8, height,
    width >>> 8, width,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

describe("validatePhoto", () => {
  it("accepts PNG and JPEG dimensions and returns an immutable copy", () => {
    const source = png();
    const parsed = validatePhoto(source, "photo.PNG");
    source[16] = 9;
    expect(parsed).toMatchObject({ mimeType: "image/png", width: 3, height: 2 });
    expect(parsed.bytes[16]).toBe(0);

    expect(validatePhoto(jpeg(640, 480), "camera.jpg")).toMatchObject({
      mimeType: "image/jpeg", width: 640, height: 480,
    });
  });

  it("rejects extension mismatches, zero dimensions, and malformed data", () => {
    expect(() => validatePhoto(png(), "wrong.jpg")).toThrow("extension");
    expect(() => validatePhoto(png(0, 2), "zero.png")).toThrow("dimensions");
    expect(() => validatePhoto(new Uint8Array(), "empty.png")).toThrow("empty");
    expect(() => validatePhoto(Uint8Array.from([0x47, 0x49, 0x46]), "image.gif"))
      .toThrow("JPEG or PNG");
    const truncated = jpeg();
    expect(() => validatePhoto(truncated.slice(0, -2), "bad.jpg")).toThrow("JPEG");
  });

  it("rejects photos above the explicit byte limit", () => {
    expect(() => validatePhoto(new Uint8Array(MAX_PHOTO_BYTES + 1), "large.png"))
      .toThrow("byte limit");
  });
});
