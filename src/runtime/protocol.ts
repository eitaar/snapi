import type { ErrorCode } from "../errors.js";
import type { SessionExport } from "../session/types.js";
import type { ChatInput, EncryptedContent, PhotoSnapInput } from "./content-types.js";
import type { FriendSnapshot } from "../friends/types.js";

export interface SerializedAppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface RuntimeAuthUpdate {
  readonly accountId: string;
  readonly httpToken: string;
  readonly cookieHeader: string;
  readonly ssoCookieHeader: string;
  readonly mcsCofSequenceIds: string;
}

export function toRuntimeAuthUpdate(session: SessionExport): RuntimeAuthUpdate {
  return {
    accountId: session.accountId,
    httpToken: session.auth.httpToken,
    cookieHeader: session.auth.cookieHeader,
    ssoCookieHeader: session.auth.ssoCookieHeader ?? session.auth.cookieHeader,
    mcsCofSequenceIds: session.auth.requestHeaders["mcs-cof-ids-bin"] ?? "",
  };
}

export type RuntimeCommand =
  | { readonly method: "initialize"; readonly session: SessionExport }
  | { readonly method: "updateAuth"; readonly auth: RuntimeAuthUpdate }
  | { readonly method: "encryptChat"; readonly input: ChatInput }
  | { readonly method: "decryptChat"; readonly input: EncryptedContent }
  | { readonly method: "createPhotoSnap"; readonly input: PhotoSnapInput }
  | { readonly method: "refreshAuth" }
  | { readonly method: "exportState" }
  | { readonly method: "syncMessages" }
  | { readonly method: "syncFriends" }
  | { readonly method: "drainChatMessages" }
  | { readonly method: "drainSnapMessages" }
  | { readonly method: "shutdown" };

export type RuntimeRequest = RuntimeCommand & { readonly id: number };

export type RuntimeResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SerializedAppError };
