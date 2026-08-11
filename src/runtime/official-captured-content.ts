import { AppError } from "../errors.js";
import { decodeGrpcWebFrames } from "../wire/grpc-web.js";
import { readFields } from "../wire/protobuf.js";
import type { EncryptedContent } from "./content-types.js";
import type { CapturedOfficialRequest } from "./official-network.js";

const CREATE_CONTENT_MESSAGE_PATH =
  "/messagingcoreservice.MessagingCoreService/CreateContentMessage";

export function isCapturedCreateContentMessage(
  request: CapturedOfficialRequest,
): boolean {
  return request.method.toUpperCase() === "POST" && request.url.includes(CREATE_CONTENT_MESSAGE_PATH);
}

export function extractCapturedChatEnvelope(
  requests: readonly CapturedOfficialRequest[],
): EncryptedContent {
  const request = requests.find(isCapturedCreateContentMessage);
  if (request === undefined) {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Captured CreateContentMessage request is missing",
    );
  }
  let dataFrames: readonly Uint8Array[];
  try {
    dataFrames = decodeGrpcWebFrames(request.body)
      .filter((frame) => frame.kind === "data")
      .map((frame) => frame.payload);
  } catch {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Captured CreateContentMessage gRPC-Web body is malformed",
    );
  }
  if (dataFrames.length !== 1) {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Captured CreateContentMessage must contain exactly one gRPC-Web data frame",
    );
  }
  let envelopes: readonly Uint8Array[];
  try {
    envelopes = readFields(dataFrames[0]!).flatMap((field) =>
      field.fieldNumber === 4 && field.wireType === 2 ? [field.value] : []);
  } catch {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Captured CreateContentMessage protobuf body is malformed",
    );
  }
  if (envelopes.length !== 1) {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Captured CreateContentMessage must contain exactly one ContentEnvelope field",
    );
  }
  return {
    bytes: envelopes[0]!,
    contentType: "chat",
    createContentMessagePayload: dataFrames[0]!,
  };
}
