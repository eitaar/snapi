import { describe, expect, it, vi } from "vitest";
import { runReadOnlyAuthProbe, type ReadOnlyAuthProbeInput } from "../../src/diagnostics/read-only-auth-probe.js";

const fixture = (
  mode: ReadOnlyAuthProbeInput["mode"],
  overrides: Partial<ReadOnlyAuthProbeInput["request"]> = {},
): ReadOnlyAuthProbeInput => ({
  authEpoch: "edge-capture-1",
  mode,
  request: {
    url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
    method: "POST",
    headers: {
      accept: "application/grpc-web+proto",
      "content-type": "application/grpc-web+proto",
      authorization: "Bearer header-must-be-replaced",
      cookie: "cookie=header-must-be-replaced",
      "x-grpc-web": "1",
      "x-unknown": "drop-me",
    },
    bodyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
    ...overrides,
  },
  auth: {
    httpToken: "token-sentinel",
    cookieHeader: "web-cookie=sentinel",
  },
});

describe("runReadOnlyAuthProbe", () => {
  it("adds only Bearer in node-bearer mode", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-sentinel");
      expect(headers.has("cookie")).toBe(false);
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 401 });
    });

    const observation = await runReadOnlyAuthProbe(fixture("node-bearer"), { fetch });

    expect(observation).toMatchObject({
      authEpoch: "edge-capture-1",
      context: "node-bearer",
      endpointPath: "/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      status: 401,
      requestBodyBytes: 4,
    });
    expect(JSON.stringify(observation)).not.toContain("token-sentinel");
    expect(JSON.stringify(observation)).not.toContain("web-cookie");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("adds the exported web cookie only in node-web-cookie mode", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-sentinel");
      expect(headers.get("cookie")).toBe("web-cookie=sentinel");
      return new Response(null, { status: 200 });
    });

    const observation = await runReadOnlyAuthProbe(fixture("node-web-cookie"), { fetch });

    expect(observation.status).toBe(200);
    expect(JSON.stringify(observation)).not.toContain("sentinel");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["GET", "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", "only allows POST"],
    ["POST", "http://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", "HTTPS is required"],
    ["POST", "https://accounts.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", "origin is not allowed"],
    ["POST", "https://web.snapchat.com/other/ReadOnly", "path is not allowlisted"],
  ] as const)("rejects %s %s before fetch", async (method, url, message) => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(runReadOnlyAuthProbe(fixture("node-bearer", { method, url }), { fetch }))
      .rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry a rate-limited response", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }));

    await expect(runReadOnlyAuthProbe(fixture("node-bearer"), { fetch }))
      .resolves.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies nested transport errors without retaining their messages", async () => {
    const failure = Object.assign(new TypeError("secret-bearing transport message"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const fetch = vi.fn(async () => { throw failure; });

    const observation = await runReadOnlyAuthProbe(fixture("node-bearer"), { fetch });

    expect(observation.transportError).toBe("timeout");
    expect(JSON.stringify(observation)).not.toContain("secret-bearing");
  });
});
