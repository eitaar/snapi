import { describe, expect, it } from "vitest";
import { decodeGrpcWebFrames, encodeDataFrame, encodeTrailerFrame } from "../../src/wire/grpc-web.js";

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe("gRPC-Web framing", () => {
  it("decodes concatenated data and trailer frames", () => {
    const bytes = concat(
      encodeDataFrame(new Uint8Array([1, 2, 3])),
      encodeTrailerFrame(new Map([["grpc-status", "0"], ["grpc-message", "ok"]])),
    );

    expect(decodeGrpcWebFrames(bytes)).toEqual([
      { kind: "data", payload: new Uint8Array([1, 2, 3]) },
      { kind: "trailers", headers: new Map([["grpc-status", "0"], ["grpc-message", "ok"]]) },
    ]);
  });

  it("rejects a big-endian declared length larger than the buffer", () => {
    expect(() => decodeGrpcWebFrames(new Uint8Array([0, 0, 0, 0, 4, 1, 2]))).toThrow("truncated gRPC-Web frame");
  });

  it("rejects unsupported frame flags", () => {
    expect(() => decodeGrpcWebFrames(new Uint8Array([1, 0, 0, 0, 0]))).toThrow("unsupported gRPC-Web frame flag");
  });
});
