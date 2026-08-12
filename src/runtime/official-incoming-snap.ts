import type { IncomingSnapMediaInfo } from "./content-types.js";

export const MAX_MEDIA_INFOS_PER_SNAP = 8;
export const MAX_PLAYBACK_LAYERS_PER_SNAP = 32;
export const MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE = 64;

export interface OfficialIncomingSnapCandidate {
  readonly senderId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly mediaInfos: readonly IncomingSnapMediaInfo[];
}

type DecodeMessageContent = (content: unknown) => unknown;

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const candidate = record(value);
  if (typeof candidate?.str === "string" && candidate.str.length > 0) return candidate.str;
  if (!(candidate?.id instanceof Uint8Array) || candidate.id.length !== 16) return undefined;
  const hex = [...candidate.id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mediaType(value: unknown): IncomingSnapMediaInfo["mediaMetadata"]["type"] {
  if (typeof value === "string") {
    if (["Image", "Video", "Audio", "Gif", "Unknown"].includes(value)) {
      return value as IncomingSnapMediaInfo["mediaMetadata"]["type"];
    }
    return "Unknown";
  }
  switch (value) {
    case 0: return "Image";
    case 1: return "Video";
    case 2: return "Gif";
    case 3: return "Audio";
    default: return "Unknown";
  }
}

function sameMediaListId(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if ((typeof left === "bigint" || typeof left === "number" || typeof left === "string") &&
      (typeof right === "bigint" || typeof right === "number" || typeof right === "string")) {
    return String(left) === String(right);
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (leftRecord?.str !== undefined || rightRecord?.str !== undefined) {
    return leftRecord?.str !== undefined && rightRecord?.str !== undefined &&
      String(leftRecord.str) === String(rightRecord.str);
  }
  return false;
}

function mediaReferenceFor(snapdoc: Record<string, any>, media: Record<string, any>): unknown {
  const mediaListId = record(media.mediaId)?.mediaListId;
  if (mediaListId !== undefined) {
    const reference = (snapdoc.mediaReferences ?? []).find((candidate: unknown) =>
      sameMediaListId(record(candidate)?.mediaListId, mediaListId));
    if (reference !== undefined) return reference;
  }
  return snapdoc.mediaReferences?.[0];
}

export function extractOfficialMediaInfos(value: unknown): IncomingSnapMediaInfo[] {
  const snapdoc = record(value);
  if (snapdoc === undefined) return [];
  const playback = record(snapdoc.playback);
  const characteristics = record(playback?.playbackCharacteristics);
  const infos: IncomingSnapMediaInfo[] = [];
  const layers = Array.isArray(playback?.playbackLayers)
    ? playback.playbackLayers.slice(0, MAX_PLAYBACK_LAYERS_PER_SNAP)
    : [];
  for (const layer of layers) {
    const layerRecord = record(layer);
    const mediaLayer = record(layerRecord?.layer);
    if (mediaLayer?.$case !== "media") continue;
    const media = record(mediaLayer.media);
    if (media === undefined) continue;
    const reference = mediaReferenceFor(snapdoc, media);
    if (reference === undefined) continue;
    infos.push({
      mediaMetadata: {
        encryptionInfo: media.encryptionInfoV2 ?? media.encryptionInfoV1,
        dimensions: media.dimensions,
        hasSound: Boolean(characteristics?.hasSound || media.hasSound),
        zipped: Boolean(media.zipped),
        type: mediaType(media.type),
      },
      mediaReference: reference,
    });
    if (infos.length === MAX_MEDIA_INFOS_PER_SNAP) break;
  }
  return infos;
}

export function normalizeOfficialIncomingSnapMessages(
  messages: readonly unknown[],
  decode: DecodeMessageContent,
  receivedAt = new Date().toISOString(),
): OfficialIncomingSnapCandidate[] {
  const normalized: OfficialIncomingSnapCandidate[] = [];
  for (const value of messages.slice(0, MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE)) {
    try {
      const message = record(value);
      const descriptor = record(message?.descriptor);
      const senderId = identifier(message?.senderId);
      const conversationId = identifier(descriptor?.conversationId);
      const messageId = identifier(descriptor?.messageId);
      if (
        senderId === undefined ||
        conversationId === undefined ||
        messageId === undefined ||
        message?.messageContent === undefined
      ) continue;
      const decoded = record(decode(message.messageContent));
      const content = record(decoded?.content);
      const snapdoc = content?.$case === "snapdoc" ? content.snapdoc : undefined;
      if (snapdoc === undefined) continue;
      normalized.push({
        senderId,
        conversationId,
        messageId,
        timestamp: receivedAt,
        mediaInfos: extractOfficialMediaInfos(snapdoc),
      });
    } catch {
      // Unknown protected content stays inside the runtime boundary.
    }
  }
  return normalized;
}
