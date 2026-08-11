import { describe, expect, it, vi } from "vitest";
import { createOfficialNetworkBoundary } from "../../src/runtime/official-network.js";

describe("official capture-only network boundary", () => {
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
    const networkFetch = vi.fn(async () => response);
    const boundary = createOfficialNetworkBoundary(true, networkFetch);
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
