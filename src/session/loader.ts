import { readFile } from "node:fs/promises";
import { AppError } from "../errors.js";
import { parseJsonWithBytes } from "./binary-json.js";
import { parseSessionExport } from "./schema.js";
import { isSealedSessionEnvelope, SealedSessionStore } from "./sealed-store.js";
import type { SessionProtector } from "./dpapi.js";
import type { SessionExport } from "./types.js";

export interface LoadSessionOptions {
  readonly protector?: SessionProtector;
}

export async function loadSession(path: string, options: LoadSessionOptions = {}): Promise<SessionExport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read session export", { path });
  }

  let value: unknown;
  try {
    value = parseJsonWithBytes(text);
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Session export is not valid JSON", { path });
  }
  if (isSealedSessionEnvelope(value)) {
    return new SealedSessionStore(path, options.protector).read();
  }
  return parseSessionExport(value);
}
