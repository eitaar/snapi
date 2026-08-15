import { describe, expect, it } from "vitest";
import { captureWebpackModules } from "../../src/compat/module-scanner.js";
import { createWebpackRuntime, rebindWebpackFactories } from "../../src/runtime/webpack-runtime.js";

describe("host Webpack runtime", () => {
  it("rebinds captured factories so async exports resume in the host realm", async () => {
    const captured = captureWebpackModules(`
      (globalThis.webpackChunk_snapchat_web = globalThis.webpackChunk_snapchat_web || []).push([
        [1],
        { 7(module) { module.exports = async (value) => { await Promise.resolve(); return value + 1; }; } }
      ]);
    `);
    const runtime = createWebpackRuntime(rebindWebpackFactories(captured));
    const exported = runtime.require("7") as (value: number) => Promise<number>;
    await expect(exported(4)).resolves.toBe(5);
  });

  it("uses explicit stubs without executing the replaced factory", () => {
    const captured = captureWebpackModules(`
      (globalThis.webpackChunk_snapchat_web = globalThis.webpackChunk_snapchat_web || []).push([
        [1], { 8(module) { throw new Error("must not run"); } }
      ]);
    `);
    const runtime = createWebpackRuntime(rebindWebpackFactories(captured), new Map([["8", { safe: true }]]));
    expect(runtime.require("8")).toEqual({ safe: true });
  });

  it("supports the array-form export getter table used by the da4d bundle", () => {
    const captured = captureWebpackModules(`
      (globalThis.webpackChunk_snapchat_web = globalThis.webpackChunk_snapchat_web || []).push([
        [1], { 9(module, exports, require) {
          const value = 42;
          require.d(exports, ["answer", 0, value]);
        } }
      ]);
    `);
    const runtime = createWebpackRuntime(rebindWebpackFactories(captured));

    expect((runtime.require("9") as { readonly answer: number }).answer).toBe(42);
  });
});
