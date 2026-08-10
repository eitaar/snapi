import type { ModuleFactory } from "../compat/types.js";
import type { SessionExport } from "../session/types.js";
import type {
  AuthRefreshResult,
  ChatInput,
  ChatMessage,
  CryptoStateExport,
  EncryptedContent,
  PhotoSnapInput,
} from "./content-types.js";

export interface BundleContext {
  readonly session: SessionExport;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly modules: ReadonlyMap<string, ModuleFactory>;
  readonly wasmInstance: WebAssembly.Instance;
}

export interface BuildAdapter {
  readonly buildId: "8dd50222";
  initialize(context: BundleContext): Promise<void>;
  encryptChat(input: ChatInput): Promise<EncryptedContent>;
  decryptChat(input: EncryptedContent): Promise<ChatMessage>;
  createPhotoSnap(input: PhotoSnapInput): Promise<EncryptedContent>;
  refreshAuth(): Promise<AuthRefreshResult>;
  exportState(): Promise<CryptoStateExport>;
}
