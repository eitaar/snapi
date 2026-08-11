import { AppError } from "../errors.js";
import type { SessionExport } from "./types.js";

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{64,8192}$/;
const MESSAGING_PATH_PREFIX = "/messagingcoreservice.MessagingCoreService/";
const GATEWAY_URL = "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";
const ALLOWED_REQUEST_HEADERS = [
  "mcs-cof-ids-bin",
  "x-grpc-web",
  "x-snap-client-user-agent",
  "x-user-agent",
] as const;

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

interface HarEntry {
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown> | undefined;
  readonly startedDateTime: string | undefined;
}

function entriesFrom(har: unknown): readonly HarEntry[] {
  const entries = record(record(har)?.log)?.entries;
  if (!Array.isArray(entries)) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR does not contain a request entry list");
  }
  return entries.flatMap((candidate) => {
    const entry = record(candidate);
    const request = record(entry?.request);
    if (request === undefined) return [];
    return [{
      request,
      response: record(entry?.response),
      startedDateTime: typeof entry?.startedDateTime === "string" ? entry.startedDateTime : undefined,
    }];
  });
}

function urlOf(entry: HarEntry): URL | undefined {
  if (typeof entry.request.url !== "string") return undefined;
  try {
    return new URL(entry.request.url);
  } catch {
    return undefined;
  }
}

function latest(entries: readonly HarEntry[]): HarEntry | undefined {
  return [...entries].sort((left, right) => {
    const leftTime = left.startedDateTime === undefined ? 0 : Date.parse(left.startedDateTime);
    const rightTime = right.startedDateTime === undefined ? 0 : Date.parse(right.startedDateTime);
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  }).at(-1);
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~-]{64,8192})$/.exec(value ?? "");
  return match?.[1];
}

function gatewayToken(value: string | undefined): string | undefined {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes("snap-ws-auth")) return undefined;
  const tokens = parts.filter((part) => part !== "snap-ws-auth" && TOKEN_PATTERN.test(part));
  return tokens.length === 1 ? tokens[0] : undefined;
}

export function enrichSessionWithHarAuth(
  session: SessionExport,
  har: unknown,
): SessionExport {
  const entries = entriesFrom(har);
  const ssoEntry = latest(entries.filter((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "POST" &&
      entry.response?.status === 200 &&
      url?.origin === "https://accounts.snapchat.com" &&
      url.pathname === "/accounts/sso";
  }));
  if (ssoEntry === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR does not contain an accounts SSO request");
  }
  const cookie = header(ssoEntry.request.headers, "cookie");
  const ssoScuid = header(ssoEntry.request.headers, "scuid");
  const responseAccountId = header(ssoEntry.response?.headers, "scuid");
  if (cookie === undefined || ssoScuid === undefined || responseAccountId === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO request is missing required authentication headers");
  }
  if (responseAccountId.toLowerCase() !== session.accountId.toLowerCase()) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO account does not match the session export");
  }

  const messagingEntry = latest(entries.filter((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "POST" &&
      entry.response?.status === 200 &&
      url?.origin === "https://web.snapchat.com" &&
      url.pathname.startsWith(MESSAGING_PATH_PREFIX) &&
      bearerToken(header(entry.request.headers, "authorization")) !== undefined;
  }));
  if (messagingEntry === undefined) {
    throw new AppError(
      "INVALID_SESSION_EXPORT",
      "HAR does not contain successful Messaging API authentication",
    );
  }
  const httpToken = bearerToken(header(messagingEntry.request.headers, "authorization"))!;

  const gatewayEntry = latest(entries.filter((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "GET" &&
      entry.response?.status === 101 &&
      url?.href === GATEWAY_URL &&
      gatewayToken(header(entry.request.headers, "sec-websocket-protocol")) !== undefined;
  }));
  const observedGatewayToken = gatewayEntry === undefined
    ? undefined
    : gatewayToken(header(gatewayEntry.request.headers, "sec-websocket-protocol"));
  if (observedGatewayToken === undefined || observedGatewayToken !== httpToken) {
    throw new AppError(
      "INVALID_SESSION_EXPORT",
      "HAR gateway authentication does not match successful Messaging API authentication",
    );
  }

  const requestHeaders = { ...session.auth.requestHeaders };
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = header(messagingEntry.request.headers, name);
    if (value !== undefined) requestHeaders[name] = value;
  }
  const webCookieEntry = latest(entries.filter((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "POST" &&
      entry.response?.status === 200 &&
      url?.origin === "https://web.snapchat.com" &&
      bearerToken(header(entry.request.headers, "authorization")) === httpToken &&
      header(entry.request.headers, "cookie") !== undefined;
  }));
  const webCookie = webCookieEntry === undefined
    ? session.auth.cookieHeader
    : header(webCookieEntry.request.headers, "cookie")!;
  const capturedAt = messagingEntry.startedDateTime;
  if (capturedAt === undefined || Number.isNaN(Date.parse(capturedAt))) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR Messaging request has no valid capture timestamp");
  }
  return {
    ...session,
    exportedAt: new Date(capturedAt).toISOString(),
    auth: {
      ...session.auth,
      httpToken,
      gatewayToken: observedGatewayToken,
      cookieHeader: webCookie,
      ssoCookieHeader: cookie,
      ssoScuid,
      requestHeaders,
    },
  };
}

export const enrichSessionWithHarSso = enrichSessionWithHarAuth;
