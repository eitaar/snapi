import { AppError } from "../errors.js";
import type {
  FinalizedOfficialUpload,
  OfficialMediaCrypto,
  OfficialPhotoMessageContent,
} from "../runtime/official-photo-content.js";
import type { UnaryCallOptions, UnaryResult } from "../transport/grpc-client.js";
import { encodeGetUploadLocationsRequest, parseUploadLocation } from "./upload-location.js";

interface UploadBuilder {
  encryptMedia(reference: unknown): Promise<OfficialMediaCrypto>;
  finalizeUpload(
    content: OfficialPhotoMessageContent,
    index: number,
    reference: unknown,
    contentObject: Uint8Array,
    cryptoKeyIvPair: OfficialMediaCrypto["cryptoKeyIvPair"],
  ): Promise<FinalizedOfficialUpload>;
}

interface UploadGrpc {
  unary(
    service: string,
    method: string,
    payload: Uint8Array,
    options: UnaryCallOptions,
  ): Promise<UnaryResult>;
}

export interface OfficialUploadDependencies {
  readonly builder: UploadBuilder;
  readonly grpc: UploadGrpc;
  readonly fetch?: typeof globalThis.fetch;
}

export async function uploadOfficialPhotoContent(
  original: OfficialPhotoMessageContent,
  dependencies: OfficialUploadDependencies,
): Promise<FinalizedOfficialUpload> {
  if (original.localMediaReferences.length !== 1) {
    throw new AppError("UPLOAD_FAILED", "Native photo Snap requires exactly one local media reference", {
      count: original.localMediaReferences.length,
    });
  }
  const reference = original.localMediaReferences[0]!;
  const encrypted = await dependencies.builder.encryptMedia(reference);
  const locationResult = await dependencies.grpc.unary(
    "snapchat.content.v2.MediaDeliveryService",
    "GetUploadLocations",
    encodeGetUploadLocationsRequest(),
    {
      timeoutMs: 30_000,
      retryKind: "idempotent",
      replayPolicy: "idempotent",
    },
  );
  const location = parseUploadLocation(locationResult.data);
  const body = new ArrayBuffer(encrypted.encryptedData.length);
  new Uint8Array(body).set(encrypted.encryptedData);
  let response: Response;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(location.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  } catch (error) {
    throw new AppError("UPLOAD_FAILED", "Encrypted photo upload failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (!response.ok) {
    throw new AppError("UPLOAD_FAILED", "Encrypted photo upload returned an HTTP error", {
      status: response.status,
    });
  }
  return dependencies.builder.finalizeUpload(
    original,
    0,
    reference,
    location.contentObject,
    encrypted.cryptoKeyIvPair,
  );
}
