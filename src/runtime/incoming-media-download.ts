import { AppError } from "../errors.js";
import type { OfficialFetch } from "./official-network.js";

export const MAX_INCOMING_MEDIA_LAYERS = 4;
export const MAX_INCOMING_MEDIA_BYTES = 32 * 1024 * 1024;

export interface DownloadedIncomingMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

function tooLarge(): AppError {
  return new AppError(
    "CRYPTO_RUNTIME_FAILED",
    "Incoming Snap media exceeds the byte limit",
    { maxBytes: MAX_INCOMING_MEDIA_BYTES },
  );
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > MAX_INCOMING_MEDIA_BYTES) throw tooLarge();
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INCOMING_MEDIA_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadIncomingMedia(
  url: string,
  fetch: OfficialFetch,
): Promise<DownloadedIncomingMedia> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Incoming Snap media download failed",
      { status: response.status },
    );
  }
  return {
    bytes: await readBoundedBody(response),
    mimeType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}
