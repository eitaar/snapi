import { describe, expect, it } from "vitest";
import { decodeGatewayEnvelope, encodeGatewayEnvelope } from "../../src/wire/gateway-envelope.js";
import { writeBytesField, writeStringField } from "../../src/wire/protobuf.js";

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe("GatewayEnvelope", () => {
  it("round-trips the confirmed path and messageContents schema", () => {
    const envelope = { path: "mcs", messageContents: new Uint8Array([4, 5, 6]) };
    expect(decodeGatewayEnvelope(encodeGatewayEnvelope(envelope))).toEqual(envelope);
  });

  it("ignores unknown fields", () => {
    const bytes = concat(
      writeStringField(1, "mcs"),
      writeBytesField(2, new Uint8Array([1])),
      writeBytesField(9, new Uint8Array([9])),
    );
    expect(decodeGatewayEnvelope(bytes)).toEqual({ path: "mcs", messageContents: new Uint8Array([1]) });
  });

  it("requires exactly one non-empty path and one contents field", () => {
    expect(() => decodeGatewayEnvelope(writeBytesField(2, new Uint8Array([1])))).toThrow("path");
    expect(() => decodeGatewayEnvelope(writeStringField(1, "mcs"))).toThrow("messageContents");
    expect(() => decodeGatewayEnvelope(concat(writeStringField(1, "mcs"), writeStringField(1, "pcs"), writeBytesField(2, new Uint8Array())))).toThrow("exactly one path");
  });
});
