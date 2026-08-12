import { describe, expect, it } from "vitest";
import { serializeOfficialFriendState } from "../../src/runtime/official-friend-snapshot.js";

describe("official friend state serialization", () => {
  it("serializes relationship metadata without Fidelius device records", () => {
    const snapshot = serializeOfficialFriendState({
      friendsSyncStatus: "success",
      mutualOutgoingAndBlockedFriends: new Map([
        ["id-1", {
          user_id: "id-1",
          mutable_username: "alice",
          display: "Alice",
          type: "friend",
          direction: "mutual",
          ts: "123",
          fidelius_info: { devices: [{ public_key: "secret" }] },
        }],
      ]),
      incomingFriendRequests: new Map([
        ["id-2", {
          user_id: "id-2",
          mutable_username: "bob",
          display: "Bob",
          type: "pending",
          direction: "incoming",
          is_incoming_friend_request_viewed: false,
        }],
      ]),
    }, "2026-08-12T00:00:00.000Z");

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
      }],
      incomingRequests: [{
        userId: "id-2",
        username: "bob",
        displayName: "Bob",
        status: "pending",
        direction: "incoming",
        requestViewed: false,
      }],
    });
  });

});
