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
const ALLOWED_SSO_REQUEST_HEADERS = [
  "accept-language",
  "dnt",
  "origin",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-gpc",
  "user-agent",
] as const;
const ALLOWED_WEB_SESSION_REQUEST_HEADERS = [
  ...ALLOWED_SSO_REQUEST_HEADERS,
  "x-snap-client-user-agent",
] as const;
const DBSC_COOKIE_NAMES = new Set(["sc-a-dbsc-session", "sc-a-dbsc-rc"]);

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

function cookieEntries(cookieHeader: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return entries;
}

function responseSetCookies(response: Record<string, unknown> | undefined): readonly string[] {
  const values: string[] = [];
  if (Array.isArray(response?.headers)) {
    for (const candidate of response.headers) {
      const item = record(candidate);
      if (
        typeof item?.name === "string" &&
        item.name.toLowerCase() === "set-cookie" &&
        typeof item.value === "string"
      ) values.push(item.value);
    }
  }
  if (Array.isArray(response?.cookies)) {
    for (const candidate of response.cookies) {
      const item = record(candidate);
      if (typeof item?.name === "string" && typeof item.value === "string") {
        values.push(`${item.name}=${item.value}`);
      }
    }
  }
  return values;
}

function mergeSetCookies(
  cookieHeader: string,
  response: Record<string, unknown> | undefined,
): string {
  const entries = cookieEntries(cookieHeader);
  for (const setCookie of responseSetCookies(response)) {
    const pair = setCookie.split(";", 1)[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "") entries.delete(name);
    else entries.set(name, value);
  }
  return [...entries].map(([name, value]) => `${name}=${value}`).join("; ");
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

function allowedHeaders(headers: unknown, names: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = header(headers, name);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function usesDbscCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => {
    const name = part.trim().split("=", 1)[0];
    return name !== undefined && DBSC_COOKIE_NAMES.has(name);
  });
}

function usesAttestation(headers: unknown): boolean {
  return header(headers, "snap-att") !== undefined;
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
  const requestScuid = header(ssoEntry.request.headers, "scuid");
  const responseAccountId = header(ssoEntry.response?.headers, "scuid");
  if (cookie === undefined || requestScuid === undefined || responseAccountId === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO request is missing required authentication headers");
  }
  if (responseAccountId.toLowerCase() !== session.accountId.toLowerCase()) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR SSO account does not match the session export");
  }
  const ssoCookieHeader = mergeSetCookies(cookie, ssoEntry.response);
  const ssoRequestHeaders = allowedHeaders(ssoEntry.request.headers, ALLOWED_SSO_REQUEST_HEADERS);

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

  const webSessionEntry = latest(entries.filter((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "POST" &&
      entry.response?.status === 200 &&
      url?.origin === "https://web.snapchat.com" &&
      url.pathname === "/web-chat-session/refresh" &&
      bearerToken(header(entry.request.headers, "authorization")) === httpToken;
  }));
  const webSessionRequestHeaders = webSessionEntry === undefined
    ? undefined
    : allowedHeaders(
        webSessionEntry.request.headers,
        ALLOWED_WEB_SESSION_REQUEST_HEADERS,
      );

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
  if (observedGatewayToken === undefined) {
    throw new AppError(
      "INVALID_SESSION_EXPORT",
      "HAR does not contain successful Gateway authentication",
    );
  }
  if (observedGatewayToken !== httpToken) {
    throw new AppError(
      "INVALID_SESSION_EXPORT",
      "HAR Gateway and Messaging requests must use the same authentication token",
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
  const tokenCapturedAt = messagingEntry.startedDateTime;
  if (tokenCapturedAt === undefined || Number.isNaN(Date.parse(tokenCapturedAt))) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR Messaging request has no valid capture timestamp");
  }
  const gatewayTokenCapturedAt = gatewayEntry?.startedDateTime;
  if (gatewayTokenCapturedAt === undefined || Number.isNaN(Date.parse(gatewayTokenCapturedAt))) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR Gateway request has no valid capture timestamp");
  }
  const capturedAt = latest(
    webSessionEntry === undefined ? [messagingEntry] : [messagingEntry, webSessionEntry],
  )?.startedDateTime;
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
      tokenRefreshedAt: new Date(tokenCapturedAt).toISOString(),
      gatewayTokenCapturedAt: new Date(gatewayTokenCapturedAt).toISOString(),
      ...(webSessionEntry?.startedDateTime === undefined
        ? {}
        : { webSessionRefreshedAt: new Date(webSessionEntry.startedDateTime).toISOString() }),
      cookieHeader: webCookie,
      ssoCookieHeader,
      ssoScuid: requestScuid,
      ssoUsesDbsc: usesDbscCookie(ssoCookieHeader),
      ssoUsesAttestation: usesAttestation(ssoEntry.request.headers),
      ...(Object.keys(ssoRequestHeaders).length === 0 ? {} : { ssoRequestHeaders }),
      ...(webSessionRequestHeaders === undefined || Object.keys(webSessionRequestHeaders).length === 0
        ? {}
        : { webSessionRequestHeaders }),
      requestHeaders,
    },
  };
}

export const enrichSessionWithHarSso = enrichSessionWithHarAuth;
