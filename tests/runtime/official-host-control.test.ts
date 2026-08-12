import { describe, expect, it, vi } from "vitest";
import {
  beginOfficialCaptureOnly,
  drainOfficialCapturedRequests,
  syncOfficialFriends,
} from "../../src/runtime/official-host-control.js";
import type { OfficialWorkerClient } from "../../src/runtime/official-worker-client.js";

describe("official Worker host control", () => {
  it("uses only the two allowlisted host-control paths", async () => {
    const captured = [{ url: "https://example.test", method: "POST", body: new Uint8Array([1]) }];
    const apply = vi.fn(async (path: readonly string[]) =>
      path[1] === "drainCapturedRequests" ? captured : true);
    const client = { apply } as unknown as OfficialWorkerClient;

    await beginOfficialCaptureOnly(client);
    await expect(drainOfficialCapturedRequests(client)).resolves.toEqual(captured);
    expect(apply.mock.calls).toEqual([
      [["__host", "beginCaptureOnly"]],
      [["__host", "drainCapturedRequests"]],
    ]);
  });

  it("sanitizes the official friend snapshot before returning it", async () => {
    const apply = vi.fn(async (path: readonly string[]) => {
      if (path[1] === "syncFriends") {
        return {
          syncedAt: "2026-08-12T00:00:00.000Z",
          status: "success",
          friends: [{
            userId: "id-1",
            username: "alice",
            displayName: "Alice",
            status: "friend",
            direction: "mutual",
            fideliusInfo: { devices: [{ publicKey: "secret" }] },
          }],
          incomingRequests: [],
        };
      }
      return undefined;
    });
    const client = { apply } as unknown as OfficialWorkerClient;

    await expect(syncOfficialFriends(client)).resolves.toEqual({
      syncedAt: "2026-08-12T00:00:00.000Z",
      status: "success",
      friends: [{
        userId: "id-1",
        username: "alice",
        displayName: "Alice",
        status: "friend",
        direction: "mutual",
      }],
      incomingRequests: [],
    });
    expect(apply).toHaveBeenCalledWith(["__host", "syncFriends"]);
  });
});
