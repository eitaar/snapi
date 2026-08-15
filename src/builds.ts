import type { AssetRecord } from "./session/types.js";

export const SUPPORTED_BUILD_IDS = ["8dd50222", "da4d065e"] as const;

export type BuildId = (typeof SUPPORTED_BUILD_IDS)[number];

export function isSupportedBuildId(value: unknown): value is BuildId {
  return typeof value === "string" && (SUPPORTED_BUILD_IDS as readonly string[]).includes(value);
}

export interface BuildProfile {
  readonly buildId: BuildId;
  readonly assets: readonly AssetRecord[];
  readonly webUserAgent: string;
  readonly officialWorker: {
    readonly mainAsset: string;
    readonly bootstrapAsset: string;
    readonly dynamicChunkAsset: string;
    readonly wasmAsset: string;
    readonly dynamicChunkUrl: string;
    readonly wasmUrl: string;
    readonly webpackRequireVariable: string;
    readonly mainRuntimeEntryId: string;
    readonly userStoreModuleId: string;
    readonly collidingWorkerModuleIds: readonly string[];
  };
  readonly attestationWasmUrl: string;
}

const ATTESTATION_WASM_URL = "https://cf-st.sc-cdn.net/dw/c3e1083e9403dafd38c4.wasm";
const OFFICIAL_WASM_ORIGIN = "https://cf-st.sc-cdn.net/dw/";

const BUILD_PROFILES: { readonly [K in BuildId]: BuildProfile } = {
  "8dd50222": {
    buildId: "8dd50222",
    assets: [
      {
        kind: "javascript",
        filename: "41f8a232e0dafca526c7.js",
        sha256: "9ea45314e4f13777330816567d68b146e9a3e4a02973ed54560a3ca65463980b",
        size: 8_977_740,
      },
      {
        kind: "javascript",
        filename: "4577c38d10436a1f90f1.chunk.js",
        sha256: "e96e503d349d315c99b396bab35af25fbf6714c35fc73707df0c02accca10a13",
        size: 66_137,
      },
      {
        kind: "javascript",
        filename: "269b973c69f9ca2dcc93.chunk.js",
        sha256: "8bcca75a45b14bc18af218f69f273109a944adb5c31b902370ac67b3e265c81f",
        size: 1_550_593,
      },
      {
        kind: "wasm",
        filename: "903641c0ba985b2dcd13.wasm",
        sha256: "2ce913a96d256605ea3b9998e71a65ee93b4f736fa4289d27490ed7fa5a95cd5",
        size: 12_326_439,
      },
    ],
    webUserAgent: "Mozilla/5.0 SnapchatWeb/8dd50222",
    officialWorker: {
      mainAsset: "41f8a232e0dafca526c7.js",
      bootstrapAsset: "4577c38d10436a1f90f1.chunk.js",
      dynamicChunkAsset: "269b973c69f9ca2dcc93.chunk.js",
      wasmAsset: "903641c0ba985b2dcd13.wasm",
      dynamicChunkUrl: `${OFFICIAL_WASM_ORIGIN}269b973c69f9ca2dcc93.chunk.js`,
      wasmUrl: `${OFFICIAL_WASM_ORIGIN}903641c0ba985b2dcd13.wasm`,
      webpackRequireVariable: "s",
      mainRuntimeEntryId: "28420",
      userStoreModuleId: "78425",
      collidingWorkerModuleIds: ["61056", "20606", "33326"],
    },
    attestationWasmUrl: ATTESTATION_WASM_URL,
  },
  "da4d065e": {
    buildId: "da4d065e",
    assets: [
      {
        kind: "javascript",
        filename: "9c7241693746d9324c46.js",
        sha256: "596fd25e3efa6e514d26953e7f92ce74e3600951a15fab05eee9361422bc82ee",
        size: 8_956_445,
      },
      {
        kind: "javascript",
        filename: "7d1e753bedce8c25fc95.chunk.js",
        sha256: "1e63696c9e8fdb410a39c9d11b476a2bcaee0da13263e1627b906240ec889dbe",
        size: 66_305,
      },
      {
        kind: "javascript",
        filename: "4f0e6933a127015ffe00.chunk.js",
        sha256: "a4302badad70a39f777381cd98542e2ac47499d8c11a2b33a35ae8e0e851f668",
        size: 1_418_707,
      },
      {
        kind: "wasm",
        filename: "903641c0ba985b2dcd13.wasm",
        sha256: "2ce913a96d256605ea3b9998e71a65ee93b4f736fa4289d27490ed7fa5a95cd5",
        size: 12_326_439,
      },
    ],
    webUserAgent: "Mozilla/5.0 SnapchatWeb/da4d065e",
    officialWorker: {
      mainAsset: "9c7241693746d9324c46.js",
      bootstrapAsset: "7d1e753bedce8c25fc95.chunk.js",
      dynamicChunkAsset: "4f0e6933a127015ffe00.chunk.js",
      wasmAsset: "903641c0ba985b2dcd13.wasm",
      dynamicChunkUrl: `${OFFICIAL_WASM_ORIGIN}4f0e6933a127015ffe00.chunk.js`,
      wasmUrl: `${OFFICIAL_WASM_ORIGIN}903641c0ba985b2dcd13.wasm`,
      webpackRequireVariable: "r",
      mainRuntimeEntryId: "28420",
      userStoreModuleId: "96821",
      collidingWorkerModuleIds: ["61056", "20606", "33326"],
    },
    attestationWasmUrl: ATTESTATION_WASM_URL,
  },
};

export function getBuildProfile(buildId: BuildId): BuildProfile {
  return BUILD_PROFILES[buildId];
}
