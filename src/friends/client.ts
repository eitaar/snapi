import type { EasyFriendSnapshot, FriendSnapshot } from "./types.js";
import { AppError } from "../errors.js";
import type { RequestAuthSource } from "../transport/auth-provider.js";

export interface FriendsRuntime {
  syncFriends(): Promise<FriendSnapshot>;
  syncFriendsForSending?(): Promise<EasyFriendSnapshot>;
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
    return this.withSessionRefresh(() => this.dependencies.runtime.syncFriends());
  }

  async listEasy(): Promise<EasyFriendSnapshot> {
    if (this.dependencies.runtime.syncFriendsForSending === undefined) {
      throw new AppError(
        "SESSION_REEXPORT_REQUIRED",
        "Send-ready friend listing requires the messaging session state",
      );
    }
    return this.withSessionRefresh(() => this.dependencies.runtime.syncFriendsForSending!());
  }

  private async withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "SESSION_EXPIRED" || this.dependencies.auth === undefined) {
        throw error;
      }
      await this.dependencies.auth.refreshOnce({ kind: "expired" });
      await this.dependencies.updateRuntimeAuth?.();
      return operation();
    }
  }
}
