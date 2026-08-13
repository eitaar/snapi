import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

const BUILD_ID = "8dd50222" as const;
const GATEWAY_URL = "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";
const MESSAGING_ORIGIN = "https://web.snapchat.com";
const READ_ONLY_MESSAGING_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/BatchDeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);
const MESSAGING_PATH_PREFIX = "/messagingcoreservice.MessagingCoreService/";
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{64,8192}$/;
const SAFE_HTTP_PROTOCOLS = new Set(["h2", "h3", "http/1.1"]);

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

function headerNames(headers: unknown): readonly string[] {
  if (!Array.isArray(headers)) return [];
  return [...new Set(headers.flatMap((candidate) => {
    const name = record(candidate)?.name;
    return typeof name === "string" && name.trim() !== "" ? [name.toLowerCase()] : [];
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
    const protocol = entry.httpVersion?.toLowerCase();
    return protocol !== undefined && SAFE_HTTP_PROTOCOLS.has(protocol) ? [protocol] : [];
  }))].sort();
}

function requestBody(entry: HarEntry): Uint8Array | undefined {
  const text = record(entry.request.postData)?.text;
  return typeof text === "string" ? new TextEncoder().encode(text) : undefined;
}

function latest(entries: readonly HarEntry[]): HarEntry | undefined {
  return entries.at(-1);
}

function buildIsPinned(har: Record<string, unknown>): boolean {
  return record(record(har.log)?.creator)?.version === BUILD_ID;
}

export function summarizeAuthBindingHar(input: string | Uint8Array): AuthBindingHarSummary {
  const har = parseHar(input);
  if (!buildIsPinned(har)) throw invalid("HAR build is unsupported");
  const entries = entriesFrom(har);
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
  const gatewayHeaders = headerNames(gateway.request.headers);
  return {
    buildId: BUILD_ID,
    gateway101Count: gateways.length,
    messagingSuccessCount: messages.length,
    messagingWriteCount: writes.length,
    gatewayMessagingTokenEqual: true,
    ...(headerValue(gateway.request.headers, "origin") === undefined
      ? {}
      : { gatewayOrigin: headerValue(gateway.request.headers, "origin")! }),
    gatewayHasCookie: gatewayHeaders.includes("cookie"),
    gatewayHasAuthorization: gatewayHeaders.includes("authorization"),
    gatewayRequestHeaderNames: gatewayHeaders,
    messagingRequestHeaderNames: headerNames(messaging.request.headers),
    gatewayProtocols: ["snap-ws-auth"],
    messagingProtocols: safeProtocols(messages),
    ...(gateway.startedDateTime === undefined ? {} : { gatewayStartedAt: gateway.startedDateTime }),
    ...(messaging.startedDateTime === undefined ? {} : { messagingStartedAt: messaging.startedDateTime }),
    ...(body === undefined ? {} : {
      messagingBodyBytes: body.byteLength,
      messagingBodySha256: createHash("sha256").update(body).digest("hex"),
    }),
  };
}
