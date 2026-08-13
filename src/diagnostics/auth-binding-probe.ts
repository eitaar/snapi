import { createHash } from "node:crypto";
import { connect } from "node:http2";
import { AppError } from "../errors.js";
import { probeGatewayHandshake } from "../gateway/handshake.js";
import { runReadOnlyAuthProbe, type ReadOnlyAuthProbeInput } from "./read-only-auth-probe.js";
import type { SafeAuthBindingObservation } from "./auth-binding-types.js";

const HTTP2_ORIGIN = "https://web.snapchat.com";
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
  return input.request;
}

async function validateHttp2Request(
  input: NodeAuthBindingProbeInput,
  request: ReadOnlyAuthProbeInput["request"],
  now: NodeAuthBindingProbeDependencies["now"],
): Promise<void> {
  const localValidationFetch: typeof globalThis.fetch = async () => {
    throw new Error("Local read-only validation completed");
  };
  await runReadOnlyAuthProbe({
    authEpoch: input.authEpoch,
    mode: "node-web-cookie",
    request,
    auth: input.auth,
  }, {
    fetch: localValidationFetch,
    ...(now === undefined ? {} : { now }),
  });
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
    tokenEqualsEpochBaseline: true,
  };
}

async function runHttp1(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation> {
  const request = requireMessagingRequest(input);
  const observation = await runReadOnlyAuthProbe({
    authEpoch: input.authEpoch,
    mode: "node-web-cookie",
    request,
    auth: input.auth,
  }, {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return {
    authEpoch: observation.authEpoch,
    context: "node-http1",
    operation: "messaging-read",
    endpointPath: observation.endpointPath,
    startedAt: observation.startedAt,
    ...(observation.status === undefined ? {} : { status: observation.status }),
    protocol: "http/1.1",
    requestBodyBytes: observation.requestBodyBytes,
    requestBodySha256: observation.requestBodySha256,
    safeHeaderNames: observation.safeHeaderNames,
    tokenEqualsEpochBaseline: true,
    ...(observation.transportError === undefined ? {} : { transportError: observation.transportError }),
  };
}

async function runHttp2(
  input: NodeAuthBindingProbeInput,
  dependencies: NodeAuthBindingProbeDependencies,
): Promise<SafeAuthBindingObservation> {
  const request = requireMessagingRequest(input);
  await validateHttp2Request(input, request, dependencies.now);
  const url = new URL(request.url);
  const body = new Uint8Array(Buffer.from(request.bodyBase64, "base64"));
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
    tokenEqualsEpochBaseline: true,
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
