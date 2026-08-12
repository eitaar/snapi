import { describe, expect, it, vi } from "vitest";
import {
  IncomingSnapQueue,
  MAX_PENDING_INCOMING_SNAPS,
} from "../../src/runtime/incoming-snap-queue.js";
import type { OfficialIncomingSnapCandidate } from "../../src/runtime/official-incoming-snap.js";

function candidate(index = 0): OfficialIncomingSnapCandidate {
  return {
    senderId: "sender",
    conversationId: "conversation",
    messageId: `message-${index}`,
    timestamp: "2026-08-12T00:00:00.000Z",
    mediaInfos: [],
  };
}

describe("IncomingSnapQueue", () => {
  it("ignores candidates without a subscription and resolves only while draining an active one", async () => {
    const queue = new IncomingSnapQueue();
    const resolve = vi.fn(async (value: OfficialIncomingSnapCandidate) => ({
      type: "snap.received" as const,
      senderId: value.senderId,
      conversationId: value.conversationId,
      messageId: value.messageId,
      timestamp: value.timestamp,
      media: [],
    }));

    queue.enqueue([candidate(0)]);
    await expect(queue.drain(resolve)).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();

    queue.setActive(true);
    queue.enqueue([candidate(1)]);
    expect(resolve).not.toHaveBeenCalled();
    await expect(queue.drain(resolve)).resolves.toEqual([
      expect.objectContaining({ messageId: "message-1" }),
    ]);
    expect(resolve).toHaveBeenCalledOnce();

    queue.setActive(false);
    queue.enqueue([candidate(2)]);
    await expect(queue.drain(resolve)).resolves.toEqual([]);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("fails closed before resolution when the pending queue exceeds its cap", async () => {
    const queue = new IncomingSnapQueue();
    const resolve = vi.fn();
    queue.setActive(true);
    queue.enqueue(Array.from({ length: MAX_PENDING_INCOMING_SNAPS + 1 }, (_, index) => candidate(index)));

    await expect(queue.drain(resolve)).rejects.toMatchObject({
      code: "CRYPTO_RUNTIME_FAILED",
      details: { maxPendingSnaps: MAX_PENDING_INCOMING_SNAPS },
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
