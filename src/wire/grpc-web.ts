import { concatBytes } from "./protobuf.js";

export type GrpcWebFrame =
  | { readonly kind: "data"; readonly payload: Uint8Array }
  | { readonly kind: "trailers"; readonly headers: ReadonlyMap<string, string> };

function encodeFrame(flag: 0x00 | 0x80, payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffffffff) throw new RangeError("gRPC-Web frame is too large");
  const header = new Uint8Array(5);
  header[0] = flag;
  new DataView(header.buffer).setUint32(1, payload.length, false);
  return concatBytes(header, payload);
}

export function encodeDataFrame(payload: Uint8Array): Uint8Array {
  return encodeFrame(0x00, payload);
}

export function encodeTrailerFrame(headers: ReadonlyMap<string, string>): Uint8Array {
  const lines = [...headers.entries()].map(([name, value]) => `${name.toLowerCase()}: ${value}`);
  return encodeFrame(0x80, new TextEncoder().encode(`${lines.join("\r\n")}\r\n`));
}

export function parseTrailers(payload: Uint8Array): ReadonlyMap<string, string> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  const headers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new RangeError("malformed gRPC-Web trailer");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) throw new RangeError(`duplicate gRPC-Web trailer: ${name}`);
    headers.set(name, value);
  }
  return headers;
}

export function decodeGrpcWebFrames(bytes: Uint8Array): readonly GrpcWebFrame[] {
  const frames: GrpcWebFrame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) throw new RangeError("truncated gRPC-Web frame header");
    const flag = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    const payloadStart = offset + 5;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > bytes.length) throw new RangeError("truncated gRPC-Web frame payload");
    const payload = bytes.slice(payloadStart, payloadEnd);
    if (flag === 0x00) {
      frames.push({ kind: "data", payload });
    } else if (flag === 0x80) {
      frames.push({ kind: "trailers", headers: parseTrailers(payload) });
    } else {
      throw new RangeError(`unsupported gRPC-Web frame flag: ${flag}`);
    }
    offset = payloadEnd;
  }
  return frames;
}
