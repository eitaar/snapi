import { parseArgs } from "node:util";
import { findExactFriend } from "../../friends/snapshot.js";
import type { FriendSnapshot } from "../../friends/types.js";
import type { CliIo } from "../io.js";

export interface FriendsListClient {
  listFriends(): Promise<FriendSnapshot>;
  close(): Promise<void>;
}

export interface ConfiguredFriendsListClient {
  readonly client: FriendsListClient;
  readonly output: "human" | "json";
}

export type FriendsListClientFactory = () => Promise<ConfiguredFriendsListClient>;

export async function runFriendsList(
  argv: readonly string[],
  io: CliIo,
  createClient: FriendsListClientFactory,
): Promise<number> {
  let json = false;
  let query: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        query: { type: "string" },
      },
    });
    json = parsed.values.json;
    query = parsed.values.query;
  } catch {
    io.stderr("Usage: snap friends list [--json] [--query QUERY]");
    return 2;
  }

  const configured = await createClient();
  try {
    const snapshot = await configured.client.listFriends();
    if (query !== undefined) {
      const friend = findExactFriend(query, snapshot);
      if (json || configured.output === "json") {
        io.stdout(JSON.stringify({ type: "friends.match", friend }));
      } else {
        io.stdout(`${friend.username ?? friend.userId}: ${friend.status}`);
      }
      return 0;
    }
    if (json || configured.output === "json") {
      io.stdout(JSON.stringify({ type: "friends.list", ...snapshot }));
    } else {
      io.stdout(`Friends: ${snapshot.friends.length}; incoming requests: ${snapshot.incomingRequests.length}`);
    }
    return 0;
  } finally {
    await configured.client.close();
  }
}
