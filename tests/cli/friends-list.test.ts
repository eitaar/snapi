import { describe, expect, it, vi } from "vitest";
import { runFriendsList } from "../../src/cli/commands/friends-list.js";
import type { FriendSnapshot } from "../../src/friends/types.js";

const snapshot: FriendSnapshot = {
  syncedAt: "2026-08-12T00:00:00.000Z",
  status: "success",
  friends: [{
    userId: "id-1",
    username: "alice",
    displayName: "Alice",
    status: "friend",
    direction: "mutual",
  }],
  incomingRequests: [],
};

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: { version: "0.1.0", stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) },
  };
}

describe("friends list command", () => {
  it("prints only the safe friend snapshot as JSON", async () => {
    const output = io();
    const close = vi.fn(async () => undefined);
    const code = await runFriendsList([], output.value, async () => ({
      client: { listFriends: async () => snapshot, close },
      output: "json",
    }));

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({ type: "friends.list", ...snapshot });
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses exact local matching for a query", async () => {
    const output = io();
    const code = await runFriendsList(["--query", "ALICE"], output.value, async () => ({
      client: { listFriends: async () => snapshot, close: async () => undefined },
      output: "json",
    }));

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({ type: "friends.match", friend: snapshot.friends[0] });
  });

  it("prints send-ready recipient and conversation IDs in easy JSON mode", async () => {
    const output = io();
    const easy = {
      friends: [{
        recipientId: "id-1",
        conversationId: "conversation-1",
        username: "alice",
        displayName: "Alice",
      }],
    };
    const code = await runFriendsList(["--easy", "--json"], output.value, async () => ({
      client: {
        listFriends: async () => snapshot,
        listEasyFriends: async () => easy,
        close: async () => undefined,
      },
      output: "human",
    }));

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({ type: "friends.easy", ...easy });
  });

  it("prints labeled send-ready fields in human easy mode", async () => {
    const output = io();
    const easy = {
      friends: [{
        recipientId: "id-1",
        conversationId: "conversation-1",
        username: "alice",
        displayName: "Alice",
      }],
    };
    const code = await runFriendsList(["--easy"], output.value, async () => ({
      client: {
        listFriends: async () => snapshot,
        listEasyFriends: async () => easy,
        close: async () => undefined,
      },
      output: "human",
    }));

    expect(code).toBe(0);
    expect(output.stdout).toEqual([
      "Send-ready friends: 1",
      "",
      "1. alice (Alice)",
      "   Recipient ID: id-1",
      "   Conversation ID: conversation-1",
    ]);
  });

  it("does not let SNAP_OUTPUT=json override human easy mode without --json", async () => {
    const output = io();
    const easy = {
      friends: [{
        recipientId: "id-1",
        conversationId: "conversation-1",
        username: "alice",
        displayName: "Alice",
      }],
    };
    const code = await runFriendsList(["--easy"], output.value, async () => ({
      client: {
        listFriends: async () => snapshot,
        listEasyFriends: async () => easy,
        close: async () => undefined,
      },
      output: "json",
    }));

    expect(code).toBe(0);
    expect(output.stdout).toEqual([
      "Send-ready friends: 1",
      "",
      "1. alice (Alice)",
      "   Recipient ID: id-1",
      "   Conversation ID: conversation-1",
    ]);
  });

  it("explains when no send-ready friends are available in human easy mode", async () => {
    const output = io();
    const code = await runFriendsList(["--easy"], output.value, async () => ({
      client: {
        listFriends: async () => snapshot,
        listEasyFriends: async () => ({ friends: [] }),
        close: async () => undefined,
      },
      output: "human",
    }));

    expect(code).toBe(0);
    expect(output.stdout).toEqual(["No send-ready friends found."]);
  });
});
