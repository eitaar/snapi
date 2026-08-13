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

  it("includes confirmed and outgoing relationship IDs when detail maps are incomplete", () => {
    const snapshot = serializeOfficialFriendState({
      friendsSyncStatus: "success",
      mutualOutgoingAndBlockedFriends: new Map(),
      incomingFriendRequests: new Map(),
      mutuallyConfirmedFriendIds: ["id-confirmed"],
      outgoingFriendRequestIds: ["id-outgoing"],
      publicUsers: new Map([
        ["id-confirmed", { user_id: "id-confirmed", mutable_username: "alice" }],
      ]),
    }, "2026-08-12T00:00:00.000Z");

    expect(snapshot.friends).toEqual([
      {
        userId: "id-confirmed",
        username: "alice",
        status: "friend",
        direction: "mutual",
      },
      {
        userId: "id-outgoing",
        status: "pending",
        direction: "outgoing",
      },
    ]);
  });

  it("retains detailed map metadata when a confirmed ID also exists", () => {
    const snapshot = serializeOfficialFriendState({
      friendsSyncStatus: "success",
      mutualOutgoingAndBlockedFriends: new Map([
        ["id-confirmed", { user_id: "id-confirmed", mutable_username: "alice", ts: "123" }],
      ]),
      incomingFriendRequests: new Map(),
      mutuallyConfirmedFriendIds: ["id-confirmed"],
      publicUsers: new Map(),
    }, "2026-08-12T00:00:00.000Z");

    expect(snapshot.friends).toEqual([{
      userId: "id-confirmed",
      username: "alice",
      status: "friend",
      direction: "mutual",
      addedAt: "123",
    }]);
  });

  it("normalizes official UUID wrapper objects in relationship arrays and records", () => {
    const snapshot = serializeOfficialFriendState({
      friendsSyncStatus: "success",
      mutualOutgoingAndBlockedFriends: new Map([
        [{ id: "id-confirmed", str: "id-confirmed" }, {
          user_id: { id: "id-confirmed", str: "id-confirmed" },
          mutable_username: "alice",
        }],
      ]),
      incomingFriendRequests: new Map(),
      mutuallyConfirmedFriendIds: [{ id: "id-confirmed", str: "id-confirmed" }],
      outgoingFriendRequestIds: [{ id: "id-outgoing", str: "id-outgoing" }],
      publicUsers: new Map(),
    }, "2026-08-12T00:00:00.000Z");

    expect(snapshot.friends).toEqual([
      {
        userId: "id-confirmed",
        username: "alice",
        status: "friend",
        direction: "mutual",
      },
      {
        userId: "id-outgoing",
        status: "pending",
        direction: "outgoing",
      },
    ]);
  });

});
