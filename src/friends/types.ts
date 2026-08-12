export type FriendRelationshipStatus =
  | "friend"
  | "pending"
  | "following"
  | "blocked"
  | "deleted"
  | "unknown";

export type FriendDirection = "incoming" | "outgoing" | "mutual" | "unknown";

export interface FriendRecord {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly status: FriendRelationshipStatus;
  readonly direction: FriendDirection;
  readonly addedAt?: string;
  readonly requestViewed?: boolean;
}

export interface FriendSnapshot {
  readonly syncedAt: string;
  readonly status: "success" | "failure" | "unknown";
  readonly friends: readonly FriendRecord[];
  readonly incomingRequests: readonly FriendRecord[];
}
