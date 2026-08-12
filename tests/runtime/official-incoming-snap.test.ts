import { describe, expect, it } from "vitest";
import {
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
});
