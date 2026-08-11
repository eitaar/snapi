import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { extractCapturedChatEnvelope } from "../../src/runtime/official-captured-content.js";
import { encodeDataFrame } from "../../src/wire/grpc-web.js";
import { concatBytes, writeBytesField, writeVarintField } from "../../src/wire/protobuf.js";

const endpoint = "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage";

function request(payload: Uint8Array, url = endpoint) {
  return { url, method: "POST", body: encodeDataFrame(payload) };
}

describe("captured CreateContentMessage extraction", () => {
  it("extracts the protected envelope and official CreateContentMessage payload", () => {
    const envelope = new Uint8Array([9, 8, 7]);
    const payload = concatBytes(
      writeBytesField(1, new Uint8Array(18)),
      writeVarintField(2, 1),
      writeBytesField(4, envelope),
    );
    expect(extractCapturedChatEnvelope([
      request(new Uint8Array(), "https://web.snapchat.com/telemetry"),
      request(payload),
    ])).toEqual({
      bytes: envelope,
      contentType: "chat",
      createContentMessagePayload: payload,
    });
  });

  it("fails closed when the request or envelope is absent", () => {
    expect(() => extractCapturedChatEnvelope([])).toThrowError(AppError);
    expect(() => extractCapturedChatEnvelope([request(writeVarintField(2, 1))]))
      .toThrow("ContentEnvelope field");
  });

  it("rejects malformed gRPC and protobuf request bodies", () => {
    expect(() => extractCapturedChatEnvelope([{
      url: endpoint,
      method: "POST",
      body: new Uint8Array([0]),
    }])).toThrow("gRPC-Web");
    expect(() => extractCapturedChatEnvelope([request(new Uint8Array([0]))]))
      .toThrow("protobuf");
  });

  it("rejects an ambiguous envelope field", () => {
    const duplicated = concatBytes(
      writeBytesField(4, new Uint8Array([1])),
      writeBytesField(4, new Uint8Array([2])),
    );
    expect(() => extractCapturedChatEnvelope([request(duplicated)]))
      .toThrow("exactly one ContentEnvelope");
  });
});
