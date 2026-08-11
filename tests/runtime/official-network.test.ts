import { describe, expect, it, vi } from "vitest";
import { createGuardedOfficialFetch } from "../../src/runtime/official-network.js";

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
});
