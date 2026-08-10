import type { ErrorCode } from "../errors.js";
import type { SessionExport } from "../session/types.js";
import type { ChatInput, EncryptedContent, PhotoSnapInput } from "./content-types.js";

export interface SerializedAppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type RuntimeCommand =
  | { readonly method: "initialize"; readonly session: SessionExport }
  | { readonly method: "encryptChat"; readonly input: ChatInput }
  | { readonly method: "decryptChat"; readonly input: EncryptedContent }
  | { readonly method: "createPhotoSnap"; readonly input: PhotoSnapInput }
  | { readonly method: "refreshAuth" }
  | { readonly method: "exportState" }
  | { readonly method: "shutdown" };

export type RuntimeRequest = RuntimeCommand & { readonly id: number };

export type RuntimeResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SerializedAppError };
