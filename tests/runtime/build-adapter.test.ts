import { describe, expect, it } from "vitest";
import { createBuild8dd50222Adapter } from "../../src/runtime/builds/8dd50222.js";
import type { BundleContext } from "../../src/runtime/build-adapter.js";
import type { ModuleFactory } from "../../src/compat/types.js";

function context(factory: ModuleFactory): BundleContext {
  const wasmModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return {
    session: {
      formatVersion: 1,
      accountId: "account-1",
      buildId: "8dd50222",
      exportedAt: "2026-08-10T00:00:00.000Z",
      auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
      assets: [],
      localStorage: {},
      indexedDb: { databases: [] },
    },
    assets: new Map(),
    modules: new Map([["crypto", factory]]),
    wasmInstance: new WebAssembly.Instance(wasmModule),
  };
}

describe("build 8dd50222 adapter", () => {
  it("binds the exact anchored capability shape", async () => {
    const factory: ModuleFactory = (module) => {
      const anchors = ["ContentEnvelope", "EnvelopeEncryption", "FideliusEncryption"];
      module.exports = {
        anchors,
        initializeContentRuntime: async () => undefined,
        encryptChat: async () => ({ bytes: new Uint8Array([1]), contentType: "chat" as const }),
        decryptChat: async () => ({ senderId: "s", conversationId: "c", messageId: "m", text: "t", timestamp: "now" }),
        createPhotoSnap: async () => ({ bytes: new Uint8Array([2]), contentType: "photo-snap" as const }),
        refreshAuth: async () => ({ httpToken: "h", gatewayToken: "g", refreshedAt: "now", requestHeaders: {} }),
        exportState: async () => ({ localStorage: {}, indexedDb: { databases: [] } }),
      };
    };
    const adapter = createBuild8dd50222Adapter();
    await adapter.initialize(context(factory));
    await expect(adapter.encryptChat({ recipientId: "r", conversationId: "c", clientMessageId: "id", text: "t" })).resolves.toMatchObject({ contentType: "chat" });
    await expect(adapter.exportState()).resolves.toEqual({ localStorage: {}, indexedDb: { databases: [] } });
  });

  it("fails closed when an anchored module lacks the expected callable shape", async () => {
    const factory: ModuleFactory = (module) => {
      module.exports = ["ContentEnvelope", "EnvelopeEncryption", "FideliusEncryption"];
    };
    const adapter = createBuild8dd50222Adapter();
    await expect(adapter.initialize(context(factory))).rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });
});
