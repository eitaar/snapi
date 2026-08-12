import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { GrpcWebClient } from "../../src/transport/grpc-client.js";
import { encodeDataFrame, encodeTrailerFrame } from "../../src/wire/grpc-web.js";
import { concatBytes } from "../../src/wire/protobuf.js";

function auth() {
  const requestAuth = {
    httpToken: "secret-token",
    cookieHeader: "secret-cookie",
    headers: {
      "mcs-cof-ids-bin": "cof",
      "x-grpc-web": "1",
      "not-allowed": "drop-me",
    },
  };
  return {
    getRequestAuth: vi.fn(async () => requestAuth),
    refreshOnce: vi.fn(async () => requestAuth),
  };
}

function body(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.length);
  new Uint8Array(result).set(bytes);
  return result;
}

const options = { timeoutMs: 1_000, retryKind: "message-with-client-id" as const };
const readOnlyOptions = {
  timeoutMs: 1_000,
  retryKind: "none" as const,
  replayPolicy: "read-only" as const,
};
const idempotentOptions = {
  timeoutMs: 1_000,
  retryKind: "idempotent" as const,
  replayPolicy: "idempotent" as const,
};
const ambiguousSendOptions = {
  timeoutMs: 1_000,
  retryKind: "message-with-client-id" as const,
  replayPolicy: "ambiguous-send" as const,
};

describe("GrpcWebClient", () => {
  it("frames a unary request, allowlists headers, and parses data plus trailers", async () => {
    const source = auth();
    const responseBody = concatBytes(
      encodeDataFrame(new Uint8Array([4, 5, 6])),
      encodeTrailerFrame(new Map([["grpc-status", "0"], ["grpc-message", "OK"]])),
    );
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body(responseBody), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary(
      "messagingcoreservice.MessagingCoreService",
      "CreateContentMessage",
      new Uint8Array([1, 2, 3]),
      ambiguousSendOptions,
    )).resolves.toMatchObject({ data: new Uint8Array([4, 5, 6]), httpStatus: 200 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("content-type")).toBe("application/grpc-web+proto");
    expect(headers.get("mcs-cof-ids-bin")).toBe("cof");
    expect(headers.has("not-allowed")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(encodeDataFrame(new Uint8Array([1, 2, 3])));
  });

  it("refreshes once on HTTP 401 and retries a read-only request", async () => {
    const source = auth();
    const ok = concatBytes(
      encodeDataFrame(new Uint8Array([9])),
      encodeTrailerFrame(new Map([["grpc-status", "0"]])),
    );
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(body(ok), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array([8]), readOnlyOptions))
      .resolves.toMatchObject({ data: new Uint8Array([9]) });
    expect(source.refreshOnce).toHaveBeenCalledWith({ kind: "http", status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes once on HTTP 403 and retries an idempotent request", async () => {
    const source = auth();
    const ok = concatBytes(
      encodeDataFrame(new Uint8Array([7])),
      encodeTrailerFrame(new Map([["grpc-status", "0"]])),
    );
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(body(ok), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array([8]), idempotentOptions))
      .resolves.toMatchObject({ data: new Uint8Array([7]) });
    expect(source.refreshOnce).toHaveBeenCalledWith({ kind: "http", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a second HTTP 401 without a refresh loop", async () => {
    const source = auth();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array([8]), readOnlyOptions))
      .rejects.toMatchObject({ code: "NETWORK_FAILED", details: { status: 401 } });
    expect(source.refreshOnce).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh or retry an ambiguous send after HTTP 401", async () => {
    const source = auth();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array([8]), ambiguousSendOptions))
      .rejects.toMatchObject({ code: "NETWORK_FAILED", details: { status: 401 } });
    expect(source.refreshOnce).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refreshes once on gRPC 16 and rejects a second authentication failure", async () => {
    const source = auth();
    const unauthenticated = concatBytes(
      encodeDataFrame(new Uint8Array()),
      encodeTrailerFrame(new Map([["grpc-status", "16"]])),
    );
    const fetch = vi.fn(async () => new Response(body(unauthenticated), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array(), readOnlyOptions))
      .rejects.toMatchObject({ code: "GRPC_FAILED", details: { grpcStatus: 16 } });
    expect(source.refreshOnce).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh or retry an ambiguous send after gRPC 16", async () => {
    const source = auth();
    const unauthenticated = concatBytes(
      encodeDataFrame(new Uint8Array()),
      encodeTrailerFrame(new Map([["grpc-status", "16"]])),
    );
    const fetch = vi.fn(async () => new Response(body(unauthenticated), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    await expect(client.unary("service.Name", "Method", new Uint8Array(), ambiguousSendOptions))
      .rejects.toMatchObject({ code: "GRPC_FAILED", details: { grpcStatus: 16 } });
    expect(source.refreshOnce).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports rate limiting and malformed responses without secret values", async () => {
    const source = auth();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(new Response(body(new Uint8Array([0])), { status: 200 }));
    const client = new GrpcWebClient({ auth: source, fetch });

    const rate = await client.unary("service.Name", "Method", new Uint8Array(), readOnlyOptions)
      .catch((error: unknown) => error as AppError);
    expect(rate).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterMs: 3_000 } });
    expect(JSON.stringify(rate)).not.toContain("secret-token");

    await expect(client.unary("service.Name", "Method", new Uint8Array(), readOnlyOptions))
      .rejects.toMatchObject({ code: "GRPC_FAILED" });
  });
});
