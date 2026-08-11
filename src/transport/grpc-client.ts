import { AppError } from "../errors.js";
import { decodeGrpcWebFrames, encodeDataFrame } from "../wire/grpc-web.js";
import type { AuthRefreshReason, RequestAuthSource } from "./auth-provider.js";

const ALLOWED_REQUEST_HEADERS = new Set([
  "mcs-cof-ids-bin",
  "x-grpc-web",
  "x-snap-client-user-agent",
  "x-user-agent",
]);

export interface UnaryCallOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly retryKind: "none" | "idempotent" | "message-with-client-id";
}

export interface UnaryResult {
  readonly data: Uint8Array;
  readonly trailers: ReadonlyMap<string, string>;
  readonly httpStatus: number;
}

export interface GrpcWebClientOptions {
  readonly auth: RequestAuthSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

function safeRpcName(value: string, field: "service" | "method"): string {
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(value)) {
    throw new AppError("INVALID_CONFIG", `Invalid gRPC ${field}`, { field });
  }
  return value;
}

function copyAllowed(target: Headers, values: Readonly<Record<string, string>> | undefined): void {
  if (values === undefined) return;
  for (const [name, value] of Object.entries(values)) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) target.set(name, value);
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function refreshReason(httpStatus: number, grpcStatus?: number): AuthRefreshReason | undefined {
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "http", status: httpStatus };
  }
  if (grpcStatus === 7 || grpcStatus === 16) {
    return { kind: "grpc", status: grpcStatus };
  }
  return undefined;
}

export class GrpcWebClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GrpcWebClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://web.snapchat.com";
  }

  async unary(
    service: string,
    method: string,
    payload: Uint8Array,
    options: UnaryCallOptions,
  ): Promise<UnaryResult> {
    const url = `${this.baseUrl}/${safeRpcName(service, "service")}/${safeRpcName(method, "method")}`;
    const body = encodeDataFrame(payload);
    const requestBody = new ArrayBuffer(body.length);
    new Uint8Array(requestBody).set(body);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await this.options.auth.getRequestAuth();
      const headers = new Headers({
        accept: "application/grpc-web+proto",
        authorization: `Bearer ${auth.httpToken}`,
        "content-type": "application/grpc-web+proto",
      });
      copyAllowed(headers, auth.headers);
      copyAllowed(headers, options.headers);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers,
          body: requestBody,
          signal: controller.signal,
        });
      } catch (error) {
        throw new AppError("NETWORK_FAILED", "gRPC-Web request failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }

      const httpRefresh = refreshReason(response.status);
      if (httpRefresh !== undefined && attempt === 0) {
        await this.options.auth.refreshOnce(httpRefresh);
        continue;
      }
      if (response.status === 429) {
        throw new AppError("RATE_LIMITED", "gRPC-Web request was rate limited", {
          retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")),
        });
      }
      if (!response.ok) {
        throw new AppError("NETWORK_FAILED", "gRPC-Web request returned an HTTP error", {
          status: response.status,
        });
      }

      let frames;
      try {
        frames = decodeGrpcWebFrames(new Uint8Array(await response.arrayBuffer()));
      } catch {
        throw new AppError("GRPC_FAILED", "gRPC-Web response framing is malformed");
      }
      const dataFrames = frames.filter((frame) => frame.kind === "data");
      const trailerFrames = frames.filter((frame) => frame.kind === "trailers");
      if (dataFrames.length !== 1 || trailerFrames.length !== 1) {
        throw new AppError("GRPC_FAILED", "Unary gRPC-Web response has an unexpected frame count", {
          dataFrames: dataFrames.length,
          trailerFrames: trailerFrames.length,
        });
      }
      const trailers = trailerFrames[0]!.headers;
      const grpcStatusText = trailers.get("grpc-status") ?? response.headers.get("grpc-status");
      if (grpcStatusText === null || !/^\d+$/.test(grpcStatusText)) {
        throw new AppError("GRPC_FAILED", "gRPC-Web response is missing a valid status");
      }
      const grpcStatus = Number(grpcStatusText);
      const grpcRefresh = refreshReason(response.status, grpcStatus);
      if (grpcRefresh !== undefined && attempt === 0) {
        await this.options.auth.refreshOnce(grpcRefresh);
        continue;
      }
      if (grpcStatus !== 0) {
        throw new AppError("GRPC_FAILED", "gRPC-Web service returned an error", { grpcStatus });
      }
      return {
        data: dataFrames[0]!.payload,
        trailers,
        httpStatus: response.status,
      };
    }
    throw new AppError("GRPC_FAILED", "gRPC-Web authentication retry was exhausted");
  }
}
