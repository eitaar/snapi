import { describe, expect, it, vi } from "vitest";
import {
  downloadIncomingMedia,
  MAX_INCOMING_MEDIA_BYTES,
} from "../../src/runtime/incoming-media-download.js";
import { createOfficialNetworkBoundary } from "../../src/runtime/official-network.js";

describe("downloadIncomingMedia", () => {
  it("uses the guarded official fetch so disabled runtime networking cannot download media", async () => {
    const networkFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const boundary = createOfficialNetworkBoundary(false, networkFetch);

    await expect(downloadIncomingMedia("https://cdn.example.test/media", boundary.fetch))
      .rejects.toThrow("network access is disabled");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized media body from safe response metadata", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { "content-length": String(MAX_INCOMING_MEDIA_BYTES + 1) },
    }));

    await expect(downloadIncomingMedia("https://cdn.example.test/media", fetch))
      .rejects.toMatchObject({
        code: "CRYPTO_RUNTIME_FAILED",
        details: { maxBytes: MAX_INCOMING_MEDIA_BYTES },
      });
  });
});
