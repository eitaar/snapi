import { describe, expect, it, vi } from "vitest";
import { createOfficialNetworkBoundary } from "../../src/runtime/official-network.js";

describe("official capture-only network boundary", () => {
  it("injects the web cookie only for exact read-only web paths", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly cookie: string | null }> = [];
    const boundary = createOfficialNetworkBoundary(
      true,
      async (input, init) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, method: request.method, cookie: request.headers.get("cookie") });
        return new Response(null, { status: 200 });
      },
      { webCookieHeader: () => "cookie-sentinel" },
    );

    await boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", {
      method: "POST",
    });
    await boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups", {
      method: "POST",
    });
    await boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage", {
      method: "POST",
    });
    await boundary.fetch("https://accounts.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", {
      method: "POST",
    });
    await boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", {
      method: "GET",
    });
    await boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync", {
      method: "POST",
      headers: { cookie: "existing-cookie" },
    });

    expect(calls.map(({ method, cookie }) => ({ method, cookie }))).toEqual([
      { method: "POST", cookie: "cookie-sentinel" },
      { method: "POST", cookie: "cookie-sentinel" },
      { method: "POST", cookie: null },
      { method: "POST", cookie: null },
      { method: "GET", cookie: null },
      { method: "POST", cookie: "existing-cookie" },
    ]);
    expect(JSON.stringify(boundary.drainObservedRequests())).not.toContain("cookie-sentinel");
  });

  it("replaces a stale official bearer with the current host token", async () => {
    let authorization: string | null = null;
    const boundary = createOfficialNetworkBoundary(
      true,
      async (input, init) => {
        authorization = new Request(input, init).headers.get("authorization");
        return new Response(null, { status: 200 });
      },
      {
        webCookieHeader: () => "cookie-sentinel",
        httpToken: () => "current-token",
      },
    );

    await boundary.fetch(
      "https://web.snapchat.com/snapchat.friending.server.FriendRequests/IncomingFriendSync",
      { method: "POST", headers: { authorization: "Bearer stale-token" } },
    );

    expect(authorization).toBe("Bearer current-token");
  });

  it("records only safe path and status metadata for normal network requests", async () => {
    const boundary = createOfficialNetworkBoundary(true, async () =>
      new Response(null, { status: 401 }));

    await expect(boundary.fetch(
      "https://web.snapchat.com/web-chat-session/refresh?secret=must-not-leak#fragment",
      { method: "POST", headers: { authorization: "Bearer must-not-leak" } },
    )).resolves.toMatchObject({ status: 401 });

    expect(boundary.drainObservedRequests()).toEqual([{
      path: "https://web.snapchat.com/web-chat-session/refresh",
      method: "POST",
      responseStatus: 401,
    }]);
    expect(JSON.stringify(boundary.drainObservedRequests())).not.toContain("must-not-leak");
  });

  it("records a nested transport error code without retaining its message", async () => {
    const failure = Object.assign(new TypeError("secret-bearing failure message"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const boundary = createOfficialNetworkBoundary(true, async () => {
      throw failure;
    });

    await expect(boundary.fetch("https://web.snapchat.com/safe", { method: "POST" }))
      .rejects.toBe(failure);

    expect(boundary.drainObservedRequests()).toEqual([{
      path: "https://web.snapchat.com/safe",
      method: "POST",
      errorName: "TypeError",
      errorCode: "UND_ERR_CONNECT_TIMEOUT",
    }]);
    expect(JSON.stringify(boundary.drainObservedRequests())).not.toContain("secret-bearing");
  });

  it("classifies known request construction failures without retaining messages", async () => {
    const boundary = createOfficialNetworkBoundary(true, async () => {
      throw new TypeError("RequestInit: duplex option is required when sending a body.");
    });

    await expect(boundary.fetch("https://web.snapchat.com/safe", { method: "POST" }))
      .rejects.toThrow("duplex");

    expect(boundary.drainObservedRequests()).toEqual([{
      path: "https://web.snapchat.com/safe",
      method: "POST",
      errorName: "TypeError",
      errorReason: "request-duplex-required",
    }]);
  });

  it("observes an existing Request without consuming its body", async () => {
    const networkFetch = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1, 2, 3]);
      return new Response(null, { status: 200 });
    });
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
    const request = new Request("https://web.snapchat.com/safe", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    await expect(boundary.fetch(request)).resolves.toMatchObject({ status: 200 });
    expect(networkFetch).toHaveBeenCalledWith(request, undefined);
  });

  it("keeps an existing body usable when injecting the web cookie", async () => {
    const networkFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const actual = new Request(input, init);
      expect(actual.headers.get("cookie")).toBe("cookie-sentinel");
      expect([...new Uint8Array(await actual.arrayBuffer())]).toEqual([1, 2, 3]);
      return new Response(null, { status: 200 });
    });
    const boundary = createOfficialNetworkBoundary(true, networkFetch, {
      webCookieHeader: () => "cookie-sentinel",
    });
    const request = new Request("https://web.snapchat.com/api/158/envelope/", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    await expect(boundary.fetch(request)).resolves.toMatchObject({ status: 200 });
    expect(request.bodyUsed).toBe(false);
  });

  it("classifies the remaining safe transport failure categories", async () => {
    const cases = [
      [new TypeError("Body is unusable"), "request-body-unusable", undefined],
      [new TypeError("Request with GET/HEAD method cannot have body."), "unexpected-request-body", undefined],
      [new TypeError("fetch failed"), "fetch-failed", undefined],
      [Object.assign(new Error("opaque"), { code: "E_DIRECT" }), undefined, "E_DIRECT"],
      [Object.assign(new Error("opaque"), { code: "not safe" }), undefined, undefined],
      ["opaque", undefined, undefined],
    ] as const;

    for (const [failure, errorReason, errorCode] of cases) {
      const boundary = createOfficialNetworkBoundary(true, async () => { throw failure; });
      await expect(boundary.fetch(new URL("https://web.snapchat.com/safe"))).rejects.toBe(failure);
      expect(boundary.drainObservedRequests()).toEqual([{
        path: "https://web.snapchat.com/safe",
        method: "GET",
        errorName: failure instanceof Error ? failure.name : "UnknownError",
        ...(errorReason === undefined ? {} : { errorReason }),
        ...(errorCode === undefined ? {} : { errorCode }),
      }]);
    }
  });

  it("blocks normal network requests when network access is disabled", async () => {
    const networkFetch = vi.fn(async () => new Response());
    const boundary = createOfficialNetworkBoundary(false, networkFetch);

    await expect(boundary.fetch("https://web.snapchat.com/safe"))
      .rejects.toThrow("network access is disabled");
    expect(networkFetch).not.toHaveBeenCalled();
    expect(boundary.drainObservedRequests()).toEqual([]);
  });

  it("captures a request body in memory and never invokes network fetch", async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
    boundary.beginCaptureOnly();

    await expect(boundary.fetch("https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage", {
      method: "POST",
      body: new Uint8Array([0, 1, 2, 3]),
    })).rejects.toThrow("captured and blocked");

    expect(networkFetch).not.toHaveBeenCalled();
    expect(boundary.drainCapturedRequests()).toEqual([{
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/CreateContentMessage",
      method: "POST",
      body: new Uint8Array([0, 1, 2, 3]),
    }]);
    expect(boundary.drainCapturedRequests()).toEqual([]);
  });

  it("keeps capture-only irreversible for the lifetime of the boundary", () => {
    const boundary = createOfficialNetworkBoundary(false, async () => new Response());
    boundary.beginCaptureOnly();
    boundary.beginCaptureOnly();
    expect(boundary.captureOnly).toBe(true);
  });

  it("passes through only allowlisted read-only synchronization during capture", async () => {
    const response = new Response(new Uint8Array([0, 0, 0, 0, 0]), { status: 200 });
    const networkFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("cookie")).toBe("cookie-sentinel");
      return response;
    });
    const boundary = createOfficialNetworkBoundary(true, networkFetch, {
      webCookieHeader: () => "cookie-sentinel",
    });
    boundary.beginCaptureOnly();

    await expect(boundary.fetch(
      "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      { method: "POST", body: new Uint8Array([4, 5, 6]) },
    )).resolves.toBe(response);

    expect(networkFetch).toHaveBeenCalledOnce();
    expect(boundary.drainCapturedRequests()).toEqual([{
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      method: "POST",
      body: new Uint8Array([4, 5, 6]),
      responseStatus: 200,
    }]);
  });

  it("passes through the exact read-only group lookup during capture", async () => {
    const response = new Response(new Uint8Array([0, 0, 0, 0, 0]), { status: 200 });
    const networkFetch = vi.fn(async () => response);
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
    boundary.beginCaptureOnly();

    await expect(boundary.fetch(
      "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups",
      { method: "POST", body: new Uint8Array([7, 8, 9]) },
    )).resolves.toBe(response);

    expect(networkFetch).toHaveBeenCalledOnce();
    expect(boundary.drainCapturedRequests()).toEqual([{
      url: "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups",
      method: "POST",
      body: new Uint8Array([7, 8, 9]),
      responseStatus: 200,
    }]);
  });

  it("passes through exact read-only friend synchronization during capture", async () => {
    const response = new Response(new Uint8Array([0, 0, 0, 0, 0]), { status: 200 });
    const networkFetch = vi.fn(async () => response);
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
    boundary.beginCaptureOnly();

    await expect(boundary.fetch(
      "https://web.snapchat.com/snapchat.friending.server.FriendRequests/IncomingFriendSync",
      { method: "POST", body: new Uint8Array([10, 11]) },
    )).resolves.toBe(response);

    expect(boundary.drainCapturedRequests()).toEqual([{
      url: "https://web.snapchat.com/snapchat.friending.server.FriendRequests/IncomingFriendSync",
      method: "POST",
      body: new Uint8Array([10, 11]),
      responseStatus: 200,
    }]);
  });

  it("does not pass through a read-only synchronization without network opt-in", async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const boundary = createOfficialNetworkBoundary(false, networkFetch);
    boundary.beginCaptureOnly();

    await expect(boundary.fetch(
      "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync",
      { method: "POST" },
    )).rejects.toThrow("network access is disabled");

    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("acknowledges captured Graphene telemetry locally without network traffic", async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
    boundary.beginCaptureOnly();

    const response = await boundary.fetch("https://web.snapchat.com/graphene/web", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(response.status).toBe(200);
    expect(networkFetch).not.toHaveBeenCalled();
    expect(boundary.drainCapturedRequests()).toEqual([{
      url: "https://web.snapchat.com/graphene/web",
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      responseStatus: 200,
    }]);
  });
});
