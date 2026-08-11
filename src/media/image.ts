import { extname } from "node:path";
import { AppError } from "../errors.js";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface PhotoInput {
  readonly filename: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new AppError("INVALID_IMAGE", message, details);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 29 || !signature.every((value, index) => bytes[index] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") {
    invalid("PNG is missing the required IHDR chunk");
  }
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) invalid("JPEG is missing its end marker");
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return invalid("JPEG marker stream is malformed");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return invalid("JPEG segment is truncated");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return invalid("JPEG segment is truncated");
    if (sofMarkers.has(marker)) {
      if (length < 7) return invalid("JPEG frame header is malformed");
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += length;
  }
  return invalid("JPEG does not contain a supported frame header");
}

export function validatePhoto(bytes: Uint8Array, filename: string): PhotoInput {
  if (bytes.length === 0) invalid("Photo data is empty");
  if (bytes.length > MAX_PHOTO_BYTES) {
    invalid("Photo exceeds the byte limit", { maxBytes: MAX_PHOTO_BYTES, actualBytes: bytes.length });
  }
  const png = pngDimensions(bytes);
  const jpeg = png === undefined ? jpegDimensions(bytes) : undefined;
  if (png === undefined && jpeg === undefined) invalid("Photo must be a valid JPEG or PNG image");
  const mimeType = png === undefined ? "image/jpeg" as const : "image/png" as const;
  const extension = extname(filename).toLowerCase();
  const extensionMatches = mimeType === "image/png"
    ? extension === ".png"
    : extension === ".jpg" || extension === ".jpeg";
  if (!extensionMatches) invalid("Photo extension does not match its encoded format");
  const dimensions = png ?? jpeg!;
  if (dimensions.width === 0 || dimensions.height === 0) invalid("Photo dimensions must be non-zero");
  return { filename, mimeType, ...dimensions, bytes: bytes.slice() };
}
