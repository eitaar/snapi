import { describe, expect, it } from "vitest";
import { getBuildProfile } from "../src/builds.js";

describe("Snapchat Web build profiles", () => {
  it("describes the verified da4d065e official runtime assets", () => {
    const profile = getBuildProfile("da4d065e");

    expect(profile.assets).toEqual([
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
    ]);
    expect(profile.officialWorker).toMatchObject({
      mainAsset: "9c7241693746d9324c46.js",
      bootstrapAsset: "7d1e753bedce8c25fc95.chunk.js",
      dynamicChunkAsset: "4f0e6933a127015ffe00.chunk.js",
      wasmAsset: "903641c0ba985b2dcd13.wasm",
      webpackRequireVariable: "r",
      userStoreModuleId: "96821",
    });
  });

  it("keeps the 8dd50222 profile available as the default runtime", () => {
    expect(getBuildProfile("8dd50222").officialWorker).toMatchObject({
      mainAsset: "41f8a232e0dafca526c7.js",
      userStoreModuleId: "78425",
    });
  });
});
