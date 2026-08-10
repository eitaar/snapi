import { readFile } from "node:fs/promises";
import { AppError } from "../errors.js";
import { parseSessionExport } from "./schema.js";
import type { SessionExport } from "./types.js";

export async function loadSession(path: string): Promise<SessionExport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read session export", { path });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Session export is not valid JSON", { path });
  }
  return parseSessionExport(value);
}
