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
});
