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
});
