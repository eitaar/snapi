import { sanitizeFriendSnapshot } from "../friends/snapshot.js";
import type { FriendSnapshot } from "../friends/types.js";

function stringValue(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

function entriesOf(value: unknown): readonly [unknown, unknown][] {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.map((entry) => [undefined, entry]);
  if (value !== null && typeof value === "object") return Object.entries(value);
  return [];
}

function safeRecord(key: unknown, value: unknown, incoming: boolean): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const userId = stringValue(record.userId, record.user_id, key);
  if (userId === undefined) return undefined;
  const username = stringValue(record.username, record.mutableUsername, record.mutable_username);
  const displayName = stringValue(record.displayName, record.display_name, record.display);
  const status = stringValue(record.status, record.type) ?? (incoming ? "pending" : "unknown");
  const direction = stringValue(record.direction) ?? (incoming ? "incoming" : "unknown");
  const addedAt = stringValue(record.addedAt, record.added_at, record.ts, record.reverse_ts);
  const requestViewed = typeof record.requestViewed === "boolean"
    ? record.requestViewed
    : typeof record.isFriendRequestViewed === "boolean"
      ? record.isFriendRequestViewed
      : typeof record.is_incoming_friend_request_viewed === "boolean"
        ? record.is_incoming_friend_request_viewed
        : undefined;
  return {
    userId,
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    status,
    direction,
    ...(addedAt === undefined ? {} : { addedAt }),
    ...(requestViewed === undefined ? {} : { requestViewed }),
  };
}

export function serializeOfficialFriendState(user: unknown, syncedAt: string): FriendSnapshot {
  const state = user !== null && typeof user === "object" && !Array.isArray(user)
    ? user as Record<string, unknown>
    : {};
  const friends = entriesOf(state.mutualOutgoingAndBlockedFriends)
    .flatMap(([key, value]) => {
      const record = safeRecord(key, value, false);
      return record === undefined ? [] : [record];
    });
  const incomingRequests = entriesOf(state.incomingFriendRequests)
    .flatMap(([key, value]) => {
      const record = safeRecord(key, value, true);
      return record === undefined ? [] : [record];
    });
  const status = state.friendsSyncStatus === "success" || state.friendsSyncStatus === "failure"
    ? state.friendsSyncStatus
    : "unknown";
  return sanitizeFriendSnapshot({ syncedAt, status, friends, incomingRequests });
}
