import { isSupportedBuildId, type BuildId } from "../builds.js";

const BUILD_MARKER_ORIGINS = new Set([
  "https://web.snapchat.com",
  "https://www.snapchat.com",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function entriesFrom(har: unknown): readonly Record<string, unknown>[] {
  const entries = record(record(har)?.log)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((candidate) => {
    const entry = record(candidate);
    return entry === undefined ? [] : [entry];
  });
}

export function detectHarBuildId(har: unknown): BuildId | undefined {
  const markers = entriesFrom(har).flatMap((entry) => {
    const request = record(entry.request);
    const response = record(entry.response);
    if (request?.method !== "GET" || response?.status !== 200) return [];
    if (typeof request.url !== "string") return [];
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return [];
    }
    if (!BUILD_MARKER_ORIGINS.has(url.origin) || url.pathname !== "/web/version.json") return [];
    const version = url.searchParams.get("version");
    return version === null ? [] : [version];
  });
  const uniqueMarkers = [...new Set(markers)];
  if (uniqueMarkers.length !== 1 || !isSupportedBuildId(uniqueMarkers[0])) return undefined;
  return uniqueMarkers[0];
}
