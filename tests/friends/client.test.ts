import { describe, expect, it, vi } from "vitest";
import { FriendsClient } from "../../src/friends/client.js";
import type { FriendSnapshot } from "../../src/friends/types.js";

const snapshot: FriendSnapshot = {
  syncedAt: "2026-08-12T00:00:00.000Z",
  status: "success",
  friends: [{
    userId: "id-1",
    username: "alice",
    status: "friend",
    direction: "mutual",
  }],
  incomingRequests: [],
};

describe("FriendsClient", () => {
  it("delegates list to the runtime and returns the safe snapshot", async () => {
    const syncFriends = vi.fn(async () => snapshot);
    const client = new FriendsClient({ runtime: { syncFriends } });

    await expect(client.list()).resolves.toEqual(snapshot);
    expect(syncFriends).toHaveBeenCalledOnce();
  });

  it("delegates send-ready easy listing to the runtime", async () => {
    const easy = { friends: [{ recipientId: "id-1", conversationId: "conversation-1" }] };
    const syncFriends = vi.fn(async () => snapshot);
    const syncFriendsForSending = vi.fn(async () => easy);
    const client = new FriendsClient({ runtime: { syncFriends, syncFriendsForSending } });

    await expect(client.listEasy()).resolves.toEqual(easy);
    expect(syncFriendsForSending).toHaveBeenCalledOnce();
  });
});
