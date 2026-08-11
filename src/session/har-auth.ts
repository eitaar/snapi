import { AppError } from "../errors.js";
import type { SessionExport } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const target = name.toLowerCase();
  for (const candidate of headers) {
    const item = record(candidate);
    if (
      typeof item?.name === "string" &&
      item.name.toLowerCase() === target &&
      typeof item.value === "string" &&
      item.value.length > 0
    ) return item.value;
  }
  return undefined;
}

export function enrichSessionWithHarSso(
  session: SessionExport,
  har: unknown,
): SessionExport {
  const entries = record(record(har)?.log)?.entries;
  if (!Array.isArray(entries)) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR does not contain a request entry list");
  }
  const matches = entries.flatMap((candidate) => {
    const entry = record(candidate);
    const request = record(entry?.request);
    if (request?.method !== "POST" || typeof request.url !== "string") return [];
    try {
      const url = new URL(request.url);
      return url.origin === "https://accounts.snapchat.com" && url.pathname === "/accounts/sso"
        ? [{ request, response: record(entry?.response) }]
        : [];
    } catch {
      return [];
    }
  });
  const request = matches.at(-1);
  if (request === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR does not contain an accounts SSO request");
  }
  const cookie = header(request.request.headers, "cookie");
  const ssoScuid = header(request.request.headers, "scuid");
  const responseAccountId = header(request.response?.headers, "scuid");
  if (cookie === undefined || ssoScuid === undefined || responseAccountId === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO request is missing required authentication headers");
  }
  if (responseAccountId.toLowerCase() !== session.accountId.toLowerCase()) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO account does not match the session export");
  }
  return {
    ...session,
    auth: { ...session.auth, ssoCookieHeader: cookie, ssoScuid },
  };
}
