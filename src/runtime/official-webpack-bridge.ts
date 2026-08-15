const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
const WASM_REGISTRATION = "un.wasmModule=c,un.wasmModuleCleanup=u";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeHelperBridge(requireVariable: string): string {
  return [
    `${requireVariable}.r=e=>{typeof Symbol!=="undefined"&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})}`,
    `${requireVariable}.nmd=e=>(e.paths=[],e.children||(e.children=[]),e)`,
    `${requireVariable}.t=(e,t)=>{if(1&t&&(e=${requireVariable}(e)),8&t)return e;if("object"==typeof e&&e){if(4&t&&e.__esModule)return e;if(16&t&&"function"==typeof e.then)return e}const __codexNamespace=Object.create(null);${requireVariable}.r(__codexNamespace);const __codexSource={};for(let __codexProto=2&t&&e;__codexProto&&"object"==typeof __codexProto&&!Object.prototype.hasOwnProperty.call(__codexProto,"__esModule");__codexProto=Object.getPrototypeOf(__codexProto)){const __codexCurrent=__codexProto;for(const __codexKey of Object.getOwnPropertyNames(__codexCurrent))__codexSource[__codexKey]=()=>__codexCurrent[__codexKey]}__codexSource.default=()=>e,${requireVariable}.d(__codexNamespace,__codexSource);return __codexNamespace}`,
    `${requireVariable}.g=globalThis`,
    `${requireVariable}.dn=${requireVariable}.dn??(e=>e())`,
    `${requireVariable}.cjs=e=>{const __codexModule={exports:{}};e(__codexModule,__codexModule.exports);return __codexModule.exports}`,
  ].join(",");
}

export function patchOfficialBootstrap(source: string, requireVariable: string): string {
  if (!new RegExp(`^${IDENTIFIER}$`).test(requireVariable)) {
    throw new Error("Official bootstrap does not match the pinned Webpack bridge shape");
  }
  const escaped = escapeRegExp(requireVariable);
  const bridge = runtimeHelperBridge(requireVariable);
  const direct = new RegExp(`(${IDENTIFIER})=${escaped}\\.x,${escaped}\\.x=\\(\\)=>`);
  const named = new RegExp(`const (${IDENTIFIER})=${escaped}\\.x;${escaped}\\.x=\\(\\)=>`);
  let patched = source.replace(
    direct,
    `${bridge},globalThis.__officialWebpackRequire=${requireVariable},$1=${requireVariable}.x,${requireVariable}.x=()=>`,
  );
  if (patched === source) {
    patched = source.replace(
      named,
      `const $1=${requireVariable}.x;${bridge},globalThis.__officialWebpackRequire=${requireVariable},${requireVariable}.x=()=>`,
    );
  }
  if (patched === source) {
    throw new Error("Official bootstrap does not match the pinned Webpack bridge shape");
  }
  const withWasm = patched.replace(
    WASM_REGISTRATION,
    `un.wasmModule=c,globalThis.__officialWasmModule=c,un.wasmModuleCleanup=u`,
  );
  if (!withWasm.includes("__officialWebpackRequire") || !withWasm.includes("__officialWasmModule")) {
    throw new Error("Official bootstrap does not match the pinned Webpack bridge shape");
  }
  return withWasm;
}
