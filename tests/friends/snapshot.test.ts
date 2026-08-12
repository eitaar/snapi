import { describe, expect, it } from "vitest";
import { findExactFriend, sanitizeFriendSnapshot } from "../../src/friends/snapshot.js";

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
});
