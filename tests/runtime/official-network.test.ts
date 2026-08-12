import { describe, expect, it, vi } from "vitest";
import {
  createGuardedOfficialFetch,
  createOfficialNetworkBoundary,
} from "../../src/runtime/official-network.js";

describe("official messaging network boundary", () => {
  it("denies external fetches by default without invoking the underlying implementation", async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const guarded = createGuardedOfficialFetch(undefined, networkFetch);

    await expect(guarded("https://web.snapchat.com/messagingcoreservice.Send"))
      .rejects.toThrow("Official messaging network access is disabled");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("allows the explicitly opted-in path", async () => {
    const response = new Response(null, { status: 204 });
    const networkFetch = vi.fn(async () => response);
    const guarded = createGuardedOfficialFetch(true, networkFetch);

    await expect(guarded("https://web.snapchat.com/ping")).resolves.toBe(response);
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it("keeps only a bounded window of safe request observations", async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const boundary = createOfficialNetworkBoundary(true, networkFetch);

    for (let index = 0; index < 300; index += 1) {
      await boundary.fetch(`https://web.snapchat.com/media/${index}`);
    }

    const observed = boundary.drainObservedRequests();
    expect(observed).toHaveLength(256);
    expect(observed[0]?.path).toBe("https://web.snapchat.com/media/44");
    expect(observed.at(-1)?.path).toBe("https://web.snapchat.com/media/299");
  });
});
