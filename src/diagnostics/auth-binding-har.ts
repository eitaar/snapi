import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

const BUILD_ID = "8dd50222" as const;
const GATEWAY_URL = "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";
const MESSAGING_ORIGIN = "https://web.snapchat.com";
const EXPECTED_GATEWAY_ORIGIN = "https://www.snapchat.com";
const READ_ONLY_MESSAGING_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/BatchDeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);
const MESSAGING_PATH_PREFIX = "/messagingcoreservice.MessagingCoreService/";
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{64,8192}$/;
const SAFE_GATEWAY_REQUEST_HEADERS = new Set([
  "accept-language",
  "cache-control",
  "connection",
  "cookie",
  "origin",
  "pragma",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
  "user-agent",
]);
const SAFE_MESSAGING_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "caller-source",
  "content-type",
  "cookie",
  "dnt",
  "mcs-cof-ids-bin",
  "origin",
  "prefer",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "user-agent",
  "x-grpc-web",
  "x-snap-client-user-agent",
  "x-user-agent",
]);

export interface AuthBindingHarSummary {
  readonly buildId: "8dd50222";
  readonly gateway101Count: number;
  readonly messagingSuccessCount: number;
  readonly messagingWriteCount: number;
  readonly gatewayMessagingTokenEqual: boolean;
  readonly gatewayOrigin?: string;
  readonly gatewayHasCookie: boolean;
  readonly gatewayHasAuthorization: boolean;
  readonly gatewayRequestHeaderNames: readonly string[];
  readonly messagingRequestHeaderNames: readonly string[];
  readonly gatewayProtocols: readonly string[];
  readonly messagingProtocols: readonly string[];
  readonly gatewayStartedAt?: string;
  readonly messagingStartedAt?: string;
  readonly messagingBodyBytes?: number;
  readonly messagingBodySha256?: string;
}

interface HarEntry {
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown> | undefined;
  readonly startedDateTime: string | undefined;
  readonly httpVersion: string | undefined;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_SESSION_EXPORT", message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseHar(input: string | Uint8Array): Record<string, unknown> {
  try {
    const source = typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
    const har = record(JSON.parse(source));
    if (har === undefined) throw new Error("not a record");
    return har;
  } catch {
    throw invalid("HAR is not valid JSON");
  }
}

function entriesFrom(har: Record<string, unknown>): readonly HarEntry[] {
  const entries = record(har.log)?.entries;
  if (!Array.isArray(entries)) throw invalid("HAR does not contain a request entry list");
  return entries.flatMap((candidate) => {
    const entry = record(candidate);
    const request = record(entry?.request);
    if (request === undefined) return [];
    return [{
      request,
      response: record(entry?.response),
      startedDateTime: typeof entry?.startedDateTime === "string" ? entry.startedDateTime : undefined,
      httpVersion: typeof entry?.request === "object" && entry.request !== null &&
          typeof (entry.request as Record<string, unknown>).httpVersion === "string"
        ? (entry.request as Record<string, unknown>).httpVersion as string
        : undefined,
    }];
  });
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const target = name.toLowerCase();
  for (const candidate of headers) {
    const header = record(candidate);
    if (
      typeof header?.name === "string" &&
      header.name.toLowerCase() === target &&
      typeof header.value === "string"
    ) return header.value;
  }
  return undefined;
}

function hasHeader(headers: unknown, name: string): boolean {
  if (!Array.isArray(headers)) return false;
  const target = name.toLowerCase();
  return headers.some((candidate) => {
    const header = record(candidate);
    return typeof header?.name === "string" && header.name.toLowerCase() === target;
  });
}

function headerNames(headers: unknown, allowed: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(headers)) return [];
  return [...new Set(headers.flatMap((candidate) => {
    const name = record(candidate)?.name;
    const normalized = typeof name === "string" ? name.toLowerCase() : undefined;
    return normalized !== undefined && allowed.has(normalized) ? [normalized] : [];
  }))].sort();
}

function urlOf(entry: HarEntry): URL | undefined {
  if (typeof entry.request.url !== "string") return undefined;
  try {
    return new URL(entry.request.url);
  } catch {
    return undefined;
  }
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~-]{64,8192})$/.exec(value ?? "");
  return match?.[1];
}

function gatewayToken(value: string | undefined): string | undefined {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes("snap-ws-auth")) return undefined;
  const tokens = parts.filter((part) => TOKEN_PATTERN.test(part));
  return tokens.length === 1 ? tokens[0] : undefined;
}

function isGatewaySuccess(entry: HarEntry): boolean {
  return entry.request.method === "GET" && entry.response?.status === 101 &&
    urlOf(entry)?.href === GATEWAY_URL &&
    gatewayToken(headerValue(entry.request.headers, "sec-websocket-protocol")) !== undefined;
}

function isMessaging(entry: HarEntry): boolean {
  const url = urlOf(entry);
  return entry.request.method === "POST" && url?.origin === MESSAGING_ORIGIN &&
    url.pathname.startsWith(MESSAGING_PATH_PREFIX);
}

function isReadOnlyMessagingSuccess(entry: HarEntry): boolean {
  const url = urlOf(entry);
  return isMessaging(entry) && entry.response?.status === 200 &&
    url !== undefined && READ_ONLY_MESSAGING_PATHS.has(url.pathname) &&
    bearerToken(headerValue(entry.request.headers, "authorization")) !== undefined;
}

function safeProtocols(entries: readonly HarEntry[]): readonly string[] {
  return [...new Set(entries.flatMap((entry) => {
    const protocol = normalizeHttpVersion(entry.httpVersion);
    return protocol === undefined ? [] : [protocol];
  }))].sort();
}

function requestBody(entry: HarEntry): Uint8Array | undefined {
  const postData = record(entry.request.postData);
  const text = postData?.text;
  if (postData === undefined || typeof text !== "string") return undefined;
  if (postData.encoding === undefined) return new TextEncoder().encode(text);
  if (postData.encoding !== "base64" || !isBase64(text)) return undefined;
  return new Uint8Array(Buffer.from(text, "base64"));
}

function latest(entries: readonly HarEntry[]): HarEntry | undefined {
  return entries.at(-1);
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function normalizeHttpVersion(value: string | undefined): "h2" | "h3" | "http/1.1" | undefined {
  switch (value?.trim().toLowerCase()) {
    case "h2":
    case "http/2":
    case "http/2.0":
      return "h2";
    case "h3":
    case "http/3":
    case "http/3.0":
      return "h3";
    case "http/1.1":
      return "http/1.1";
    default:
      return undefined;
  }
}

function buildIsPinned(entries: readonly HarEntry[]): boolean {
  return entries.some((entry) => {
    const url = urlOf(entry);
    return entry.request.method === "GET" && entry.response?.status === 200 &&
      url?.origin === MESSAGING_ORIGIN && url.pathname === "/web/version.json" &&
      url.searchParams.get("version") === BUILD_ID;
  });
}

function safeGatewayOrigin(value: string | undefined): string | undefined {
  return value === EXPECTED_GATEWAY_ORIGIN ? EXPECTED_GATEWAY_ORIGIN : undefined;
}

function canonicalUtcIso(value: string | undefined): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value ?? "");
  if (match === null) return undefined;
  const canonicalInput = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const parsed = new Date(canonicalInput);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonicalInput
    ? undefined
    : parsed.toISOString();
}

export function summarizeAuthBindingHar(input: string | Uint8Array): AuthBindingHarSummary {
  const har = parseHar(input);
  const entries = entriesFrom(har);
  if (!buildIsPinned(entries)) throw invalid("HAR build is unsupported");
  const gateways = entries.filter(isGatewaySuccess);
  const messages = entries.filter(isReadOnlyMessagingSuccess);
  const writes = entries.filter((entry) => isMessaging(entry) &&
    !READ_ONLY_MESSAGING_PATHS.has(urlOf(entry)!.pathname));
  if (gateways.length === 0) throw invalid("HAR does not contain successful Gateway authentication");
  if (messages.length === 0) throw invalid("HAR does not contain successful read-only Messaging authentication");

  const gateway = latest(gateways)!;
  const messaging = latest(messages)!;
  const gatewayAuth = gatewayToken(headerValue(gateway.request.headers, "sec-websocket-protocol"));
  const messagingAuth = bearerToken(headerValue(messaging.request.headers, "authorization"));
  if (gatewayAuth === undefined || messagingAuth === undefined || gatewayAuth !== messagingAuth) {
    throw invalid("HAR Gateway and Messaging authentication do not match");
  }

  const body = requestBody(messaging);
  const gatewayHeaders = headerNames(gateway.request.headers, SAFE_GATEWAY_REQUEST_HEADERS);
  return {
    buildId: BUILD_ID,
    gateway101Count: gateways.length,
    messagingSuccessCount: messages.length,
    messagingWriteCount: writes.length,
    gatewayMessagingTokenEqual: true,
    ...(safeGatewayOrigin(headerValue(gateway.request.headers, "origin")) === undefined
      ? {}
      : { gatewayOrigin: EXPECTED_GATEWAY_ORIGIN }),
    gatewayHasCookie: gatewayHeaders.includes("cookie"),
    gatewayHasAuthorization: hasHeader(gateway.request.headers, "authorization"),
    gatewayRequestHeaderNames: gatewayHeaders,
    messagingRequestHeaderNames: headerNames(messaging.request.headers, SAFE_MESSAGING_REQUEST_HEADERS),
    gatewayProtocols: ["snap-ws-auth"],
    messagingProtocols: safeProtocols(messages),
    ...(canonicalUtcIso(gateway.startedDateTime) === undefined
      ? {}
      : { gatewayStartedAt: canonicalUtcIso(gateway.startedDateTime)! }),
    ...(canonicalUtcIso(messaging.startedDateTime) === undefined
      ? {}
      : { messagingStartedAt: canonicalUtcIso(messaging.startedDateTime)! }),
    ...(body === undefined ? {} : {
      messagingBodyBytes: body.byteLength,
      messagingBodySha256: createHash("sha256").update(body).digest("hex"),
    }),
  };
}
