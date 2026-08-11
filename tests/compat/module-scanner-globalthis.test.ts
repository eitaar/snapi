import { describe, expect, it } from "vitest";
import { captureWebpackModules } from "../../src/compat/module-scanner.js";

describe("Webpack globalThis module registration", () => {
  it("captures factories registered through globalThis", () => {
    const modules = captureWebpackModules(`
      (globalThis.webpackChunk_snapchat_web_calling_app =
        globalThis.webpackChunk_snapchat_web_calling_app || []).push([
          [42],
          { "real-shape": function(module) { module.exports = "ContentEnvelope"; } }
        ]);
    `);

    expect([...modules.keys()]).toEqual(["real-shape"]);
  });

  it("keeps VM intrinsics available to captured module factories", () => {
    const modules = captureWebpackModules(`
      (globalThis.webpackChunk_snapchat_web_calling_app =
        globalThis.webpackChunk_snapchat_web_calling_app || []).push([
          [42],
          { "uses-intrinsics": function(module) {
            module.exports = { object: Object.create(null), array: new Array(2) };
          } }
        ]);
    `);
    const module = { exports: {} as unknown };

    expect(() => modules.get("uses-intrinsics")!(module, module.exports, () => undefined))
      .not.toThrow();
    expect((module.exports as { array: unknown[] }).array).toHaveLength(2);
  });
});
