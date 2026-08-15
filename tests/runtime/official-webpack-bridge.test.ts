import { describe, expect, it } from "vitest";
import { patchOfficialBootstrap } from "../../src/runtime/official-webpack-bridge.js";

const bridgePrefix = "s.r=e=>{}";
const wasmAnchor = "un.wasmModule=c,un.wasmModuleCleanup=u";

describe("official Webpack bootstrap bridge", () => {
  it("patches the pinned 8dd runtime registration shape", () => {
    const source = `${bridgePrefix};var t=s.x,s.x=()=>s.e(7818).then(t);${wasmAnchor}`;
    const patched = patchOfficialBootstrap(source, "s");

    expect(patched).toContain("globalThis.__officialWebpackRequire=s");
    expect(patched).toContain("globalThis.__officialWasmModule=c");
  });

  it("patches the da4d runtime registration shape with its renamed require variable", () => {
    const source = `${bridgePrefix};const e=r.x;r.x=()=>r.e(7818).then(e);${wasmAnchor}`;
    const patched = patchOfficialBootstrap(source, "r");

    expect(patched).toContain("globalThis.__officialWebpackRequire=r");
    expect(patched).toContain("globalThis.__officialWasmModule=c");
    expect(patched).toContain("r.dn=r.dn??(e=>e())");
  });

  it("does not shadow the da4d require variable inside the namespace helper", () => {
    const source = `const r={e:()=>Promise.resolve(),d:(target,values)=>Object.assign(target,values)};const e=r.x;r.x=()=>r.e().then(e);const un={};const c={};const u=()=>{};${wasmAnchor}`;
    const patched = patchOfficialBootstrap(source, "r");

    expect(() => new Function("globalThis", `${patched};return r.t({},0);`)({})).not.toThrow();
  });

  it("provides the da4d CommonJS factory helper", () => {
    const source = `const r={e:()=>Promise.resolve(),d:(target,values)=>Object.assign(target,values)};const e=r.x;r.x=()=>r.e().then(e);const un={};const c={};const u=()=>{};${wasmAnchor}`;
    const patched = patchOfficialBootstrap(source, "r");

    expect(() => new Function("globalThis", `${patched};return r.cjs((module,exports)=>{exports.value=1;});`)({})).not.toThrow();
    expect(new Function("globalThis", `${patched};return r.cjs((module,exports)=>{exports.value=1;});`)({})).toEqual({ value: 1 });
  });

  it("fails closed when either bootstrap bridge anchor is absent", () => {
    expect(() => patchOfficialBootstrap("not-a-bootstrap", "r")).toThrowError(
      "Official bootstrap does not match the pinned Webpack bridge shape",
    );
  });
});
