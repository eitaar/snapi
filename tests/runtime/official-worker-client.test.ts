import { describe, expect, it } from "vitest";
import { OfficialWorkerClient, exposeOfficial } from "../../src/runtime/official-worker-client.js";

describe("OfficialWorkerClient", () => {
  it("invokes methods on nested Comlink proxies returned by the official Worker", async () => {
    const client = new OfficialWorkerClient({
      assetDir: ".",
      workerUrl: new URL("../fixtures/comlink-proxy-worker.mjs", import.meta.url),
    });

    try {
      const session = await client.createMessagingSession([
        exposeOfficial({
          readAccountId: () => "managed-account",
        }),
      ]);
      const manager = await session.callRemote(["getConversationManager"]);

      await expect(manager.call<string>(["echo"], ["hello"]))
        .resolves.toBe("managed-account:hello");
    } finally {
      await client.shutdown();
    }
  });
});
