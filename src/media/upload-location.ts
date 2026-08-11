import { AppError } from "../errors.js";
import {
  concatBytes,
  readFields,
  writeBytesField,
  writeVarintField,
  type ProtobufField,
} from "../wire/protobuf.js";

export interface UploadLocation {
  readonly uploadUrl: string;
  readonly expiresAtSeconds: number;
  readonly postSuccessValiditySeconds: number;
  readonly contentObject: Uint8Array;
}

export function encodeGetUploadLocationsRequest(): Uint8Array {
  return concatBytes(
    writeVarintField(2, 1),
    writeVarintField(4, 1),
    writeBytesField(7, new Uint8Array([0])),
    writeVarintField(16, 1),
  );
}

function fields(bytes: Uint8Array, context: string): readonly ProtobufField[] {
  try {
    return readFields(bytes);
  } catch {
    throw new AppError("UPLOAD_FAILED", `${context} protobuf is malformed`);
  }
}

function bytesField(source: readonly ProtobufField[], number: number, context: string): Uint8Array {
  const matches = source.flatMap((field) =>
    field.fieldNumber === number && field.wireType === 2 ? [field.value] : []);
  if (matches.length !== 1 || matches[0]!.length === 0) {
    throw new AppError("UPLOAD_FAILED", `${context} must contain exactly one non-empty field`, {
      fieldNumber: number,
      count: matches.length,
    });
  }
  return matches[0]!;
}

function nestedSeconds(source: readonly ProtobufField[], number: number, context: string): number {
  const nested = fields(bytesField(source, number, context), context);
  const matches = nested.flatMap((field) =>
    field.fieldNumber === 1 && field.wireType === 0 ? [field.value] : []);
  if (matches.length !== 1 || matches[0]! > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError("UPLOAD_FAILED", `${context} seconds value is invalid`);
  }
  return Number(matches[0]);
}

export function parseUploadLocation(payload: Uint8Array): UploadLocation {
  const response = fields(payload, "Upload location response");
  const locationMatches = response.flatMap((field) =>
    field.fieldNumber === 1 && field.wireType === 2 ? [field.value] : []);
  if (locationMatches.length !== 1) {
    throw new AppError("UPLOAD_FAILED", "Upload response must contain exactly one location", {
      count: locationMatches.length,
    });
  }
  const location = fields(locationMatches[0]!, "Upload location");
  const uploadUrl = new TextDecoder("utf-8", { fatal: true }).decode(
    bytesField(location, 1, "Upload location URL"),
  );
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(uploadUrl);
  } catch {
    throw new AppError("UPLOAD_FAILED", "Upload location URL is invalid");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    !(parsedUrl.hostname === "sc-cdn.net" || parsedUrl.hostname.endsWith(".sc-cdn.net"))
  ) {
    throw new AppError("UPLOAD_FAILED", "Upload location is not a trusted Snap CDN URL");
  }
  const contentReference = fields(
    bytesField(location, 4, "Upload content reference"),
    "Upload content reference",
  );
  return {
    uploadUrl,
    expiresAtSeconds: nestedSeconds(location, 2, "Upload expiry"),
    postSuccessValiditySeconds: nestedSeconds(location, 3, "Upload validity"),
    contentObject: bytesField(contentReference, 3, "Upload content object"),
  };
}
