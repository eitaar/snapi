import { describe, expect, it } from "vitest";
import type { AssetLoaderLike } from "../../src/compat/asset-loader.js";
import { CompatibilityGuard, SUPPORTED_ASSETS } from "../../src/compat/guard.js";
import type { SessionExport } from "../../src/session/types.js";

const mainChunk = `
  (globalThis.webpackChunk_snapchat_web_calling_app =
    globalThis.webpackChunk_snapchat_web_calling_app || []).push([
      [8792],
      { 76877() { return "createMessagingSession getConversationManager getFeedManager"; } }
    ]);
`;
const bootstrap = `
  (() => {
    const entryId = 73843;
    const dynamicChunk = "dw/269b973c69f9ca2dcc93.chunk.js";
    const root = {
      setAuthTokenGetter() {},
      setMcsCofSequenceIdsGetter() {},
      loadWasm() {},
      createMessagingSession() {},
      registerDuplexHandler() {},
      stop() {}
    };
    return { entryId, dynamicChunk, root };
  })();
`;
const dynamicChunk = `
  (globalThis.webpackChunk_snapchat_web_calling_app =
    globalThis.webpackChunk_snapchat_web_calling_app || []).push([
      [7818],
      { 68247(module) { module.exports = "dw/903641c0ba985b2dcd13.wasm"; } }
    ]);
`;
const minimalWasmWithMemoryExport = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

function session(): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account-1",
    buildId: "8dd50222",
    exportedAt: "2026-08-10T00:00:00.000Z",
    auth: { httpToken: "x", gatewayToken: "y", cookieHeader: "z", requestHeaders: {} },
    assets: SUPPORTED_ASSETS,
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("official messaging worker compatibility probe", () => {
  it("recognizes the observed bootstrap, dynamic chunk, and Comlink root contract", async () => {
    const loader: AssetLoaderLike = {
      loadVerified: async (record) => {
        if (record.kind === "wasm") return minimalWasmWithMemoryExport;
        if (record.filename === "4577c38d10436a1f90f1.chunk.js") return new TextEncoder().encode(bootstrap);
        if (record.filename === "269b973c69f9ca2dcc93.chunk.js") return new TextEncoder().encode(dynamicChunk);
        return new TextEncoder().encode(mainChunk);
      },
    };

    await expect(new CompatibilityGuard(loader).verify(session())).resolves.toMatchObject({
      modules: [{ capability: "messaging-wasm-worker", moduleId: "73843" }],
      wasmExports: ["memory"],
    });
  });
});
