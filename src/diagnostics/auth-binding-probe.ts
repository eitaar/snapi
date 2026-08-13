import { createHash } from "node:crypto";
import { connect } from "node:http2";
import { AppError } from "../errors.js";
import { probeGatewayHandshake } from "../gateway/handshake.js";
import type { ReadOnlyAuthProbeInput } from "./read-only-auth-probe.js";
import type { SafeAuthBindingObservation } from "./auth-binding-types.js";

const HTTP2_ORIGIN = "https://web.snapchat.com";
const AUTH_BINDING_MESSAGING_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/BatchDeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
]);
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "caller-source",
  "content-type",
  "dnt",
  "mcs-cof-ids-bin",
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
const GATEWAY_PATH = "/snapchat.gateway.Gateway/WebSocketConnect";
const TIMEOUT_MS = 10_000;

export type NodeAuthBindingMode = "node-http1" | "node-http2" | "node-gateway";

export interface NodeAuthBindingProbeInput {
  readonly authEpoch: string;
  readonly context: NodeAuthBindingMode;
  readonly request?: ReadOnlyAuthProbeInput["request"];
  readonly tokenEqualsEpochBaseline?: boolean;
  readonly auth: {
    readonly httpToken: string;
    readonly cookieHeader: string;
    readonly gatewayToken?: string;
  };
}

export interface NodeAuthBindingProbeDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly http2Connect?: typeof import("node:http2").connect;
  readonly gatewayProbe?: typeof probeGatewayHandshake;
  readonly now?: () => Date;
}

function invalidConfig(message: string): AppError {
  return new AppError("INVALID_CONFIG", message);
}

function invalidSessionExport(message: string): AppError {
  return new AppError("INVALID_SESSION_EXPORT", message);
}

function transportErrorKind(error: unknown): NonNullable<SafeAuthBindingObservation["transportError"]> {
  if (error === null || typeof error !== "object") return "other";
  const candidate = error as { readonly code?: unknown; readonly cause?: { readonly code?: unknown } };
  const code = candidate.code ?? candidate.cause?.code;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "connection";
  }
  if (
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) return "tls";
  return "other";
}

function validateCommon(input: NodeAuthBindingProbeInput): void {
  if (input.authEpoch.trim() === "") throw invalidConfig("Auth epoch is required");
  if (input.context !== "node-http1" && input.context !== "node-http2" && input.context !== "node-gateway") {
    throw invalidConfig("Node auth binding context is invalid");
  }
}

function requireMessagingRequest(input: NodeAuthBindingProbeInput): ReadOnlyAuthProbeInput["request"] {
  if (input.request === undefined) throw invalidConfig("Read-only messaging request is required");
  if (input.auth.httpToken.trim() === "" || input.auth.cookieHeader.trim() === "") {
    throw invalidSessionExport("HTTP token and web cookie are required");
  }
  return input.request;
}

function validateAndDecodeMessagingRequest(
  request: ReadOnlyAuthProbeInput["request"],
): { readonly url: URL; readonly body: Uint8Array } {
  if (request.method.toUpperCase() !== "POST") throw invalidConfig("Read-only probe only allows POST");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw invalidConfig("Read-only probe URL is invalid");
  }
  if (url.protocol !== "https:" || url.origin !== HTTP2_ORIGIN || url.search !== "" || url.hash !== "") {
    throw invalidConfig("Read-only probe URL is not allowed");
  }
  if (!AUTH_BINDING_MESSAGING_PATHS.has(url.pathname)) {
    throw invalidConfig("Auth-binding probe path is not allowlisted");
  }
  if (
    request.bodyBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bodyBase64)
  ) throw invalidConfig("Read-only probe body must be valid Base64");
  return { url, body: new Uint8Array(Buffer.from(request.bodyBase64, "base64")) };
}

function safeHttp2Headers(
  request: ReadOnlyAuthProbeInput["request"],
  auth: NodeAuthBindingProbeInput["auth"],
  path: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ":authority": "web.snapchat.com",
    ":method": "POST",
    ":path": path,
    authorization: `Bearer ${auth.httpToken}`,
    cookie: auth.cookieHeader,
  };
  for (const [name, value] of Object.entries(request.headers)) {
    if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function messagingObservation(
  input: NodeAuthBindingProbeInput,
  context: "node-http1" | "node-http2",
  endpointPath: string,
  startedAt: string,
  body: Uint8Array,
  safeHeaderNames: readonly string[],
): Omit<SafeAuthBindingObservation, "status" | "transportError"> {
  return {
    authEpoch: input.authEpoch,
    context,
    operation: "messaging-read",
    endpointPath,
    startedAt,
    protocol: context === "node-http1" ? "http/1.1" : "h2",
    requestBodyBytes: body.byteLength,
    requestBodySha256: createHash("sha256").update(body).digest("hex"),
    safeHeaderNames: [...safeHeaderNames].sort(),
    tokenEqualsEpochBaseline: input.tokenEqualsEpochBaseline === true,
  };
}

async function runHttp1(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation> {
  const request = requireMessagingRequest(input);
  const { url, body } = validateAndDecodeMessagingRequest(request);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${input.auth.httpToken}`);
  headers.set("cookie", input.auth.cookieHeader);
  const base = messagingObservation(
    input,
    "node-http1",
    url.pathname,
    (dependencies.now ?? (() => new Date()))().toISOString(),
    body,
    [...headers.keys()],
  );
  const requestBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(requestBody).set(body);
  try {
    const response = await (dependencies.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers,
      body: requestBody,
      redirect: "manual",
    });
    return { ...base, status: response.status };
  } catch (error) {
    return { ...base, transportError: transportErrorKind(error) };
  }
}

async function runHttp2(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation> {
  const request = requireMessagingRequest(input);
  const { url, body } = validateAndDecodeMessagingRequest(request);
  const headers = safeHttp2Headers(request, input.auth, url.pathname);
  const base = messagingObservation(
    input,
    "node-http2",
    url.pathname,
    (dependencies.now ?? (() => new Date()))().toISOString(),
    body,
    Object.keys(headers).filter((name) => !name.startsWith(":")),
  );
  const connectHttp2 = dependencies.http2Connect ?? connect;

  return new Promise<SafeAuthBindingObservation>((resolve) => {
    let settled = false;
    let session: ReturnType<typeof connect> | undefined;
    let stream: ReturnType<ReturnType<typeof connect>["request"]> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch {
        // Cleanup failures must not prevent a sanitized observation.
      }
    };
    const closeResources = (): void => {
      attempt(() => stream?.close());
      attempt(() => stream?.destroy());
      attempt(() => session?.close());
      attempt(() => session?.destroy());
    };
    const finish = (result: Pick<SafeAuthBindingObservation, "status" | "transportError">): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      closeResources();
      resolve({ ...base, ...result });
    };

    try {
      watchdog = setTimeout(() => finish({ transportError: "timeout" }), TIMEOUT_MS);
      session = connectHttp2(HTTP2_ORIGIN);
      session.once("error", (error) => finish({ transportError: transportErrorKind(error) }));
      stream = session.request(headers);
      stream.once("response", (responseHeaders) => {
        const status = responseHeaders[":status"];
        finish({ status: typeof status === "number" ? status : 0 });
      });
      stream.once("error", (error) => finish({ transportError: transportErrorKind(error) }));
      stream.once("timeout", () => finish({ transportError: "timeout" }));
      stream.on("data", () => undefined);
      stream.setTimeout(TIMEOUT_MS, () => finish({ transportError: "timeout" }));
      stream.end(body);
    } catch (error) {
      finish({ transportError: transportErrorKind(error) });
    }
  });
}

async function runGateway(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation> {
  if (input.auth.gatewayToken === undefined || input.auth.gatewayToken.trim() === "") {
    throw invalidSessionExport("Gateway token is required");
  }
  const base = {
    authEpoch: input.authEpoch,
    context: "node-gateway" as const,
    operation: "gateway-handshake" as const,
    endpointPath: GATEWAY_PATH,
    startedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    protocol: "websocket" as const,
    safeHeaderNames: [],
    tokenEqualsEpochBaseline: input.tokenEqualsEpochBaseline === true,
  };
  try {
    const observation = await (dependencies.gatewayProbe ?? probeGatewayHandshake)(input.auth.gatewayToken);
    return { ...base, status: observation.status };
  } catch (error) {
    return { ...base, transportError: transportErrorKind(error) };
  }
}

export async function runNodeAuthBindingProbe(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies = {},
): Promise<SafeAuthBindingObservation> {
  validateCommon(input);
  if (input.context === "node-http1") return runHttp1(input, dependencies);
  if (input.context === "node-http2") return runHttp2(input, dependencies);
  return runGateway(input, dependencies);
}
