import { concatBytes, readFields, writeBytesField, writeStringField } from "./protobuf.js";

export interface GatewayEnvelope {
  readonly path: string;
  readonly messageContents: Uint8Array;
}

export function encodeGatewayEnvelope(envelope: GatewayEnvelope): Uint8Array {
  if (envelope.path.length === 0) throw new RangeError("GatewayEnvelope path must not be empty");
  return concatBytes(
    writeStringField(1, envelope.path),
    writeBytesField(2, envelope.messageContents),
  );
}

export function decodeGatewayEnvelope(bytes: Uint8Array): GatewayEnvelope {
  const paths: string[] = [];
  const contents: Uint8Array[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 2) paths.push(decoder.decode(field.value));
    if (field.fieldNumber === 2 && field.wireType === 2) contents.push(field.value);
  }
  if (paths.length !== 1) throw new RangeError("GatewayEnvelope requires exactly one path");
  if (paths[0] === "") throw new RangeError("GatewayEnvelope path must not be empty");
  if (contents.length !== 1) {
    throw new RangeError("GatewayEnvelope requires exactly one messageContents field");
  }
  return { path: paths[0]!, messageContents: contents[0]! };
}
