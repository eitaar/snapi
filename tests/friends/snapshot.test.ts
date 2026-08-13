import { describe, expect, it } from "vitest";
import {
  buildEasyFriendSnapshot,
  findExactEasyFriend,
  findExactFriend,
  sanitizeEasyFriendSnapshot,
  sanitizeFriendSnapshot,
} from "../../src/friends/snapshot.js";

describe("friend snapshot", () => {
  it("keeps public relationship metadata and removes protected device fields", () => {
    const snapshot = sanitizeFriendSnapshot({
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [{
        userId: "id-1",
        username: "alice",
        displayName: "Alice",
        status: "friend",
        direction: "mutual",
        addedAt: "123",
        requestViewed: true,
        fideliusInfo: { devices: [{ publicKey: "secret" }] },
      }],
      incomingRequests: [],
    });

    expect(snapshot).toEqual({
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [{
        userId: "id-1",
        username: "alice",
        displayName: "Alice",
        status: "friend",
        direction: "mutual",
        addedAt: "123",
        requestViewed: true,
      }],
      incomingRequests: [],
    });
  });

  it("resolves only exact ids or exact case-insensitive names", () => {
    const snapshot = sanitizeFriendSnapshot({
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [
        { userId: "id-1", username: "alice", displayName: "Alice A", status: "friend", direction: "mutual" },
        { userId: "id-2", username: "bob", displayName: "Shared", status: "pending", direction: "outgoing" },
      ],
      incomingRequests: [{
        userId: "id-3",
        username: "carol",
        displayName: "Shared",
        status: "pending",
        direction: "incoming",
      }],
    });

    expect(findExactFriend("id-1", snapshot).userId).toBe("id-1");
    expect(findExactFriend("ALICE A", snapshot).userId).toBe("id-1");
    expect(() => findExactFriend("ali", snapshot)).toThrowError(
      expect.objectContaining({ code: "RECIPIENT_NOT_FOUND" }),
    );
    expect(() => findExactFriend("shared", snapshot)).toThrowError(
      expect.objectContaining({
        code: "RECIPIENT_NOT_FOUND",
        details: { candidates: [
          { userId: "id-2", username: "bob", displayName: "Shared" },
          { userId: "id-3", username: "carol", displayName: "Shared" },
        ] },
      }),
    );
  });

  it("keeps only mutual friends with a resolved one-to-one conversation", () => {
    const snapshot = sanitizeFriendSnapshot({
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [
        { userId: "id-1", username: "alice", displayName: "Alice", status: "friend", direction: "mutual" },
        { userId: "id-2", username: "bob", status: "friend", direction: "mutual" },
        { userId: "id-3", username: "carol", status: "pending", direction: "outgoing" },
      ],
      incomingRequests: [],
    });

    expect(buildEasyFriendSnapshot(snapshot, new Map([
      ["id-1", "conversation-1"],
      ["id-3", "conversation-3"],
    ]))).toEqual({
      friends: [{
        recipientId: "id-1",
        conversationId: "conversation-1",
        username: "alice",
        displayName: "Alice",
      }],
    });
  });

  it("resolves an easy friend by exact recipient ID or exact name", () => {
    const easy = {
      friends: [{
        recipientId: "id-1",
        conversationId: "conversation-1",
        username: "alice",
        displayName: "Alice",
      }],
    };

    expect(findExactEasyFriend("id-1", easy)).toEqual(easy.friends[0]);
    expect(findExactEasyFriend("ALICE", easy)).toEqual(easy.friends[0]);
  });

  it("rejects an easy record without a conversation ID", () => {
    expect(() => sanitizeEasyFriendSnapshot({
      friends: [{ recipientId: "id-1" }],
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});
