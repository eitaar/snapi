import { describe, expect, it } from "vitest";
import { readFields, writeBytesField, writeStringField, writeVarintField } from "../../src/wire/protobuf.js";
import { decodeVarint, encodeVarint } from "../../src/wire/varint.js";

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe("varint", () => {
  it.each([0, 127, 128, 300, Number.MAX_SAFE_INTEGER])("round-trips %s", (value) => {
    const encoded = encodeVarint(value);
    const decoded = decodeVarint(encoded);
    expect(decoded).toEqual({ value: BigInt(value), nextOffset: encoded.length });
  });

  it("rejects truncated and overlong values", () => {
    expect(() => decodeVarint(new Uint8Array([0x80]))).toThrow("truncated varint");
    expect(() => decodeVarint(new Uint8Array(10).fill(0x80))).toThrow("varint exceeds 64 bits");
  });
});

describe("minimal protobuf fields", () => {
  it("reads known and unknown fields without interpreting their meaning", () => {
    const message = concat(
      writeStringField(1, "mcs"),
      writeBytesField(2, new Uint8Array([1, 2, 3])),
      writeVarintField(9, 300),
    );

    expect(readFields(message)).toEqual([
      { fieldNumber: 1, wireType: 2, value: new TextEncoder().encode("mcs") },
      { fieldNumber: 2, wireType: 2, value: new Uint8Array([1, 2, 3]) },
      { fieldNumber: 9, wireType: 0, value: 300n },
    ]);
  });

  it("rejects field zero, unsupported wire types, and truncated bytes", () => {
    expect(() => readFields(new Uint8Array([0]))).toThrow("field number zero");
    expect(() => readFields(new Uint8Array([(1 << 3) | 5, 0, 0, 0, 0]))).toThrow("unsupported wire type");
    expect(() => readFields(new Uint8Array([(1 << 3) | 2, 4, 1, 2]))).toThrow("truncated length-delimited field");
  });
});
