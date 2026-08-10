export interface DecodedVarint {
  readonly value: bigint;
  readonly nextOffset: number;
}

const MAX_UINT64 = (1n << 64n) - 1n;

function normalizeValue(value: number | bigint): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("varint number must be a non-negative safe integer");
  }
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > MAX_UINT64) {
    throw new RangeError("varint value exceeds uint64");
  }
  return normalized;
}

export function encodeVarint(value: number | bigint): Uint8Array {
  let remaining = normalizeValue(value);
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}

export function decodeVarint(bytes: Uint8Array, offset = 0): DecodedVarint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new RangeError("invalid varint offset");
  }
  let value = 0n;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    const byte = bytes[offset++];
    if (byte === undefined) throw new RangeError("truncated varint");
    if (shift === 63n && (byte & 0x7e) !== 0) {
      throw new RangeError("varint exceeds 64 bits");
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
  }
  throw new RangeError("varint exceeds 64 bits");
}
