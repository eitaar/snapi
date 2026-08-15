import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ResolveEntryPath = (path: string) => string;

export function isCliEntryPoint(
  entryPath: string | undefined,
  moduleUrl: string,
  resolvePath: ResolveEntryPath = realpathSync,
): boolean {
  if (entryPath === undefined) return false;
  try {
    return resolvePath(entryPath) === resolvePath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
