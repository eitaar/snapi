import type { FriendSnapshot } from "./types.js";
import { AppError } from "../errors.js";
import type { RequestAuthSource } from "../transport/auth-provider.js";

export interface FriendsRuntime {
  syncFriends(): Promise<FriendSnapshot>;
  updateAuth?(session: import("../session/types.js").SessionExport): Promise<void>;
}

export interface FriendsClientDependencies {
  readonly runtime: FriendsRuntime;
  readonly auth?: RequestAuthSource;
  readonly updateRuntimeAuth?: () => Promise<void>;
}

export class FriendsClient {
  constructor(private readonly dependencies: FriendsClientDependencies) {}

  async list(): Promise<FriendSnapshot> {
    try {
      return await this.dependencies.runtime.syncFriends();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "SESSION_EXPIRED" || this.dependencies.auth === undefined) {
        throw error;
      }
      await this.dependencies.auth.refreshOnce({ kind: "expired" });
      await this.dependencies.updateRuntimeAuth?.();
      return this.dependencies.runtime.syncFriends();
    }
  }
}
