import { describe, expect, it, vi } from "vitest";
import {
  beginOfficialCaptureOnly,
  drainOfficialCapturedRequests,
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
});
