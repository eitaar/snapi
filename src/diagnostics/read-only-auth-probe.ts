import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import type { SafeAuthGapObservation } from "./auth-gap-types.js";

const ALLOWED_ORIGIN = "https://web.snapchat.com";
const ALLOWED_PATHS = new Set([
  "/messagingcoreservice.MessagingCoreService/DeltaSync",
  "/messagingcoreservice.MessagingCoreService/GetGroups",
  "/com.snapchat.deltaforce.external.DeltaForce/DeltaSync",
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

export interface ReadOnlyAuthProbeInput {
  readonly authEpoch: string;
  readonly mode: "node-bearer" | "node-web-cookie";
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyBase64: string;
  };
  readonly auth: { readonly httpToken: string; readonly cookieHeader: string };
}

export interface ReadOnlyAuthProbeDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_CONFIG", message);
}

function decodeBody(bodyBase64: string): Uint8Array {
  if (
    bodyBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bodyBase64)
  ) {
    throw invalid("Read-only probe body must be valid Base64");
  }
  return new Uint8Array(Buffer.from(bodyBase64, "base64"));
}

function bodyHash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function errorCode(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { readonly code?: unknown; readonly cause?: unknown };
  if (candidate.code !== undefined) return candidate.code;
  if (candidate.cause !== null && typeof candidate.cause === "object") {
    return (candidate.cause as { readonly code?: unknown }).code;
  }
  return undefined;
}

function transportErrorKind(
  error: unknown,
): NonNullable<SafeAuthGapObservation["transportError"]> {
  const code = errorCode(error);
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) return "timeout";
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) return "connection";
  if (
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) return "tls";
  return "other";
}

function validateRequest(input: ReadOnlyAuthProbeInput): URL {
  if (input.authEpoch.trim() === "") throw invalid("Read-only probe auth epoch is required");
  if (input.auth.httpToken.trim() === "") throw invalid("Read-only probe HTTP token is required");
  if (input.mode === "node-web-cookie" && input.auth.cookieHeader.trim() === "") {
    throw invalid("Read-only probe web cookie is required");
  }
  if (input.request.method.toUpperCase() !== "POST") {
    throw invalid("Read-only probe only allows POST");
  }

  let url: URL;
  try {
    url = new URL(input.request.url);
  } catch {
    throw invalid("Read-only probe URL is invalid");
  }
  if (url.protocol !== "https:") throw invalid("Read-only probe HTTPS is required");
  if (url.origin !== ALLOWED_ORIGIN) throw invalid("Read-only probe origin is not allowed");
  if (url.search !== "" || url.hash !== "") throw invalid("Read-only probe URL must not contain query or fragment");
  if (!ALLOWED_PATHS.has(url.pathname)) throw invalid("Read-only probe path is not allowlisted");
  return url;
}

function copySafeHeaders(
  target: Headers,
  source: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(source)) {
    if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) target.set(name, value);
  }
}

export async function runReadOnlyAuthProbe(
  input: ReadOnlyAuthProbeInput,
  dependencies: ReadOnlyAuthProbeDependencies = {},
): Promise<SafeAuthGapObservation> {
  const url = validateRequest(input);
  const body = decodeBody(input.request.bodyBase64);
  const requestBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(requestBody).set(body);
  const headers = new Headers();
  copySafeHeaders(headers, input.request.headers);
  headers.set("authorization", `Bearer ${input.auth.httpToken}`);
  if (input.mode === "node-web-cookie") headers.set("cookie", input.auth.cookieHeader);

  const observationBase = {
    authEpoch: input.authEpoch,
    context: input.mode,
    endpointPath: url.pathname,
    method: "POST" as const,
    startedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    requestBodyBytes: body.byteLength,
    requestBodySha256: bodyHash(body),
    safeHeaderNames: [...headers.keys()].sort(),
  };
  const fetch = dependencies.fetch ?? globalThis.fetch;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      redirect: "error",
    });
    return { ...observationBase, status: response.status };
  } catch (error) {
    return { ...observationBase, transportError: transportErrorKind(error) };
  }
}
