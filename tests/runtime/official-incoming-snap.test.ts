import { describe, expect, it, vi } from "vitest";
import {
  MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE,
  MAX_MEDIA_INFOS_PER_SNAP,
  extractOfficialMediaInfos,
  normalizeOfficialIncomingSnapMessages,
} from "../../src/runtime/official-incoming-snap.js";

describe("official incoming Snap decoding", () => {
  it("extracts media references from SnapDoc playback layers", () => {
    const reference = { mediaListId: "0", contentObject: new Uint8Array([1, 2, 3]) };
    const snapdoc = {
      mediaReferences: [reference],
      playback: {
        playbackCharacteristics: { hasSound: false },
        playbackLayers: [{
          layer: {
            $case: "media",
            media: {
              mediaId: { mediaListId: "0" },
              encryptionInfoV1: { key: new Uint8Array([4]), iv: new Uint8Array([5]) },
              dimensions: { width: 640, height: 480 },
              type: 0,
              hasSound: false,
              zipped: false,
            },
          },
        }],
      },
    };

    expect(extractOfficialMediaInfos(snapdoc)).toEqual([{
      mediaMetadata: {
        encryptionInfo: snapdoc.playback.playbackLayers[0]!.layer.media.encryptionInfoV1,
        dimensions: { width: 640, height: 480 },
        hasSound: false,
        zipped: false,
        type: "Image",
      },
      mediaReference: reference,
    }]);
  });

  it("normalizes a decoded SnapDoc without exposing the encrypted message payload", () => {
    const messages = [{
      descriptor: {
        messageId: { str: "snap-id" },
        conversationId: { str: "conversation-id" },
      },
      senderId: { str: "sender-id" },
      messageContent: "protected-snap",
    }];
    const snapdoc = { mediaReferences: [], playback: { playbackLayers: [] } };

    expect(normalizeOfficialIncomingSnapMessages(
      messages,
      (content) => content === "protected-snap"
        ? { content: { $case: "snapdoc", snapdoc } }
        : undefined,
      "2026-08-11T00:00:00.000Z",
    )).toEqual([{
      senderId: "sender-id",
      conversationId: "conversation-id",
      messageId: "snap-id",
      timestamp: "2026-08-11T00:00:00.000Z",
      mediaInfos: [],
    }]);
    expect(JSON.stringify(snapdoc)).not.toContain("protected-snap");
  });

  it("bounds media layers and protected-message decoding work", () => {
    const mediaReference = { mediaListId: "0" };
    const playbackLayers = Array.from({ length: MAX_MEDIA_INFOS_PER_SNAP + 1 }, () => ({
      layer: {
        $case: "media",
        media: { mediaId: { mediaListId: "0" }, type: 0 },
      },
    }));
    expect(extractOfficialMediaInfos({
      mediaReferences: [mediaReference],
      playback: { playbackLayers },
    })).toHaveLength(MAX_MEDIA_INFOS_PER_SNAP);

    const decode = vi.fn(() => ({
      content: {
        $case: "snapdoc",
        snapdoc: { mediaReferences: [], playback: { playbackLayers: [] } },
      },
    }));
    const messages = Array.from({ length: MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE + 1 }, (_, index) => ({
      descriptor: { messageId: { str: `message-${index}` }, conversationId: { str: "conversation" } },
      senderId: { str: "sender" },
      messageContent: "protected",
    }));

    expect(normalizeOfficialIncomingSnapMessages(messages, decode))
      .toHaveLength(MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE);
    expect(decode).toHaveBeenCalledTimes(MAX_INCOMING_SNAP_MESSAGES_PER_UPDATE);
  });
});
