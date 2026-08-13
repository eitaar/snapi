import { parseArgs } from "node:util";
import { AppError } from "../../errors.js";
import { findExactEasyFriend, findExactFriend } from "../../friends/snapshot.js";
import type { EasyFriendSnapshot, FriendSnapshot } from "../../friends/types.js";
import type { CliIo } from "../io.js";

export interface FriendsListClient {
  listFriends(): Promise<FriendSnapshot>;
  listEasyFriends?(): Promise<EasyFriendSnapshot>;
  close(): Promise<void>;
}

export interface ConfiguredFriendsListClient {
  readonly client: FriendsListClient;
  readonly output: "human" | "json";
}

export type FriendsListClientFactory = () => Promise<ConfiguredFriendsListClient>;

type EasyFriend = EasyFriendSnapshot["friends"][number];

function easyFriendName(friend: EasyFriend): string {
  if (friend.username !== undefined && friend.displayName !== undefined && friend.username !== friend.displayName) {
    return `${friend.username} (${friend.displayName})`;
  }
  return friend.username ?? friend.displayName ?? friend.recipientId;
}

function writeEasyFriendHuman(io: CliIo, friend: EasyFriend, index?: number): void {
  io.stdout(`${index === undefined ? "" : `${index}. `}${easyFriendName(friend)}`);
  io.stdout(`   Recipient ID: ${friend.recipientId}`);
  io.stdout(`   Conversation ID: ${friend.conversationId}`);
}

export async function runFriendsList(
  argv: readonly string[],
  io: CliIo,
  createClient: FriendsListClientFactory,
): Promise<number> {
  let json = false;
  let easy = false;
  let query: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        easy: { type: "boolean", default: false },
        query: { type: "string" },
      },
    });
    json = parsed.values.json;
    easy = parsed.values.easy;
    query = parsed.values.query;
  } catch {
    io.stderr("Usage: snap friends list [--easy] [--json] [--query QUERY]");
    return 2;
  }

  const configured = await createClient();
  try {
    if (easy) {
      if (configured.client.listEasyFriends === undefined) {
        throw new AppError(
          "SESSION_REEXPORT_REQUIRED",
          "Send-ready friend listing requires the messaging session state",
        );
      }
      const easySnapshot = await configured.client.listEasyFriends();
      if (query !== undefined) {
        const friend = findExactEasyFriend(query, easySnapshot);
        if (json) {
          io.stdout(JSON.stringify({ type: "friends.match", friend }));
        } else {
          io.stdout("Send-ready friend");
          writeEasyFriendHuman(io, friend);
        }
        return 0;
      }
      if (json) {
        io.stdout(JSON.stringify({ type: "friends.easy", ...easySnapshot }));
      } else if (easySnapshot.friends.length === 0) {
        io.stdout("No send-ready friends found.");
      } else {
        io.stdout(`Send-ready friends: ${easySnapshot.friends.length}`);
        easySnapshot.friends.forEach((friend, index) => {
          io.stdout("");
          writeEasyFriendHuman(io, friend, index + 1);
        });
      }
      return 0;
    }
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
