import { decodeVarint, encodeVarint } from "./varint.js";

export type ProtobufField =
  | { readonly fieldNumber: number; readonly wireType: 0; readonly value: bigint }
  | { readonly fieldNumber: number; readonly wireType: 2; readonly value: Uint8Array };

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function fieldKey(fieldNumber: number, wireType: 0 | 2): Uint8Array {
  if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0 || fieldNumber > 0x1fffffff) {
    throw new RangeError("invalid protobuf field number");
  }
  return encodeVarint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

export function writeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes(fieldKey(fieldNumber, 0), encodeVarint(value));
}

export function writeBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes(fieldKey(fieldNumber, 2), encodeVarint(value.length), value);
}

export function writeStringField(fieldNumber: number, value: string): Uint8Array {
  return writeBytesField(fieldNumber, new TextEncoder().encode(value));
}

export function readFields(bytes: Uint8Array): readonly ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = decodeVarint(bytes, offset);
    offset = key.nextOffset;
    const fieldNumberValue = key.value >> 3n;
    if (fieldNumberValue === 0n) throw new RangeError("protobuf field number zero");
    if (fieldNumberValue > 0x1fffffffn) throw new RangeError("protobuf field number too large");
    const fieldNumber = Number(fieldNumberValue);
    const wireType = Number(key.value & 7n);
    if (wireType === 0) {
      const decoded = decodeVarint(bytes, offset);
      fields.push({ fieldNumber, wireType: 0, value: decoded.value });
      offset = decoded.nextOffset;
      continue;
    }
    if (wireType === 2) {
      const length = decodeVarint(bytes, offset);
      offset = length.nextOffset;
      if (length.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("protobuf field length is too large");
      }
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new RangeError("truncated length-delimited field");
      fields.push({ fieldNumber, wireType: 2, value: bytes.slice(offset, end) });
      offset = end;
      continue;
    }
    throw new RangeError(`unsupported wire type: ${wireType}`);
  }
  return fields;
}
