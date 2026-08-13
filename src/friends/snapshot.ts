import { AppError } from "../errors.js";
import type {
  FriendDirection,
  FriendRecord,
  FriendRelationshipStatus,
  EasyFriendRecord,
  EasyFriendSnapshot,
  FriendSnapshot,
} from "./types.js";

const statuses = new Set<FriendRelationshipStatus>([
  "friend",
  "pending",
  "following",
  "blocked",
  "deleted",
  "unknown",
]);
const directions = new Set<FriendDirection>(["incoming", "outgoing", "mutual", "unknown"]);

function recordAt(value: unknown, path: string): FriendRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_CONFIG", `Friend record must be an object at ${path}`);
  }
  const record = value as Record<string, unknown>;
  const userId = typeof record.userId === "string"
    ? record.userId
    : typeof record.user_id === "string"
      ? record.user_id
      : "";
  if (userId.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Friend record is missing userId at ${path}`);
  }
  const username = typeof record.username === "string"
    ? record.username
    : typeof record.mutableUsername === "string"
      ? record.mutableUsername
      : typeof record.mutable_username === "string"
        ? record.mutable_username
        : undefined;
  const displayName = typeof record.displayName === "string"
    ? record.displayName
    : typeof record.display_name === "string"
      ? record.display_name
      : typeof record.display === "string"
        ? record.display
        : undefined;
  const statusValue = typeof record.status === "string"
    ? record.status.toLowerCase()
    : typeof record.type === "string"
      ? record.type.toLowerCase()
      : "unknown";
  const directionValue = typeof record.direction === "string"
    ? record.direction.toLowerCase()
    : "unknown";
  const addedAt = typeof record.addedAt === "string"
    ? record.addedAt
    : typeof record.added_at === "string"
      ? record.added_at
      : typeof record.ts === "string"
        ? record.ts
        : undefined;
  const requestViewed = typeof record.requestViewed === "boolean"
    ? record.requestViewed
    : typeof record.isFriendRequestViewed === "boolean"
      ? record.isFriendRequestViewed
      : undefined;
  return {
    userId,
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    status: statuses.has(statusValue as FriendRelationshipStatus)
      ? statusValue as FriendRelationshipStatus
      : "unknown",
    direction: directions.has(directionValue as FriendDirection)
      ? directionValue as FriendDirection
      : "unknown",
    ...(addedAt === undefined ? {} : { addedAt }),
    ...(requestViewed === undefined ? {} : { requestViewed }),
  };
}

function arrayAt(value: unknown, path: string): readonly FriendRecord[] {
  if (!Array.isArray(value)) {
    throw new AppError("INVALID_CONFIG", `Friend snapshot field must be an array at ${path}`);
  }
  return value.map((entry, index) => recordAt(entry, `${path}[${index}]`));
}

function easyRecordAt(value: unknown, path: string): EasyFriendRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_CONFIG", `Easy friend record must be an object at ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.recipientId !== "string" || record.recipientId.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Easy friend record is missing recipientId at ${path}`);
  }
  if (typeof record.conversationId !== "string" || record.conversationId.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Easy friend record is missing conversationId at ${path}`);
  }
  const username = typeof record.username === "string" && record.username.trim() !== ""
    ? record.username
    : undefined;
  const displayName = typeof record.displayName === "string" && record.displayName.trim() !== ""
    ? record.displayName
    : undefined;
  return {
    recipientId: record.recipientId,
    conversationId: record.conversationId,
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

export function sanitizeFriendSnapshot(value: unknown): FriendSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_CONFIG", "Friend snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.syncedAt !== "string" || snapshot.syncedAt.trim() === "") {
    throw new AppError("INVALID_CONFIG", "Friend snapshot is missing syncedAt");
  }
  const status = snapshot.status === "success" || snapshot.status === "failure" || snapshot.status === "unknown"
    ? snapshot.status
    : "unknown";
  return {
    syncedAt: snapshot.syncedAt,
    status,
    friends: arrayAt(snapshot.friends, "friends"),
    incomingRequests: arrayAt(snapshot.incomingRequests, "incomingRequests"),
  };
}

export function sanitizeEasyFriendSnapshot(value: unknown): EasyFriendSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_CONFIG", "Easy friend snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.friends)) {
    throw new AppError("INVALID_CONFIG", "Easy friend snapshot field must be an array");
  }
  return {
    friends: snapshot.friends.map((entry, index) => easyRecordAt(entry, `friends[${index}]`)),
  };
}

export function buildEasyFriendSnapshot(
  snapshot: FriendSnapshot,
  conversationIds: ReadonlyMap<string, string>,
): EasyFriendSnapshot {
  return {
    friends: snapshot.friends.flatMap((friend) => {
      if (friend.status !== "friend") return [];
      const conversationId = conversationIds.get(friend.userId);
      if (conversationId === undefined || conversationId.trim() === "") return [];
      return [{
        recipientId: friend.userId,
        conversationId,
        ...(friend.username === undefined ? {} : { username: friend.username }),
        ...(friend.displayName === undefined ? {} : { displayName: friend.displayName }),
      }];
    }),
  };
}

function candidate(value: FriendRecord): Readonly<Record<string, string>> {
  return {
    userId: value.userId,
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
  };
}

export function findExactFriend(query: string, snapshot: FriendSnapshot): FriendRecord {
  const normalized = query.toLocaleLowerCase("en-US");
  const unique = new Map(snapshot.friends.concat(snapshot.incomingRequests).map((value) => [value.userId, value]));
  const records = [...unique.values()];
  const exactId = records.filter(({ userId }) => userId === query);
  if (exactId.length === 1) return exactId[0]!;
  const matches = records.filter(({ username, displayName }) =>
    username?.toLocaleLowerCase("en-US") === normalized ||
    displayName?.toLocaleLowerCase("en-US") === normalized,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new AppError("RECIPIENT_NOT_FOUND", "Exact friend match was not found");
  }
  throw new AppError("RECIPIENT_NOT_FOUND", "Friend query is ambiguous", {
    candidates: matches.map(candidate),
  });
}

export function findExactEasyFriend(
  query: string,
  snapshot: EasyFriendSnapshot,
): EasyFriendRecord {
  const exactId = snapshot.friends.filter(({ recipientId }) => recipientId === query);
  if (exactId.length === 1) return exactId[0]!;

  const normalized = query.toLocaleLowerCase("en-US");
  const matches = snapshot.friends.filter(({ username, displayName }) =>
    username?.toLocaleLowerCase("en-US") === normalized ||
    displayName?.toLocaleLowerCase("en-US") === normalized,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new AppError("RECIPIENT_NOT_FOUND", "Exact send-ready friend match was not found");
  }
  throw new AppError("RECIPIENT_NOT_FOUND", "Easy friend query is ambiguous", {
    candidates: matches.map(({ recipientId, username, displayName }) => ({
      recipientId,
      ...(username === undefined ? {} : { username }),
      ...(displayName === undefined ? {} : { displayName }),
    })),
  });
}
