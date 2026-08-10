import { describe, expect, it } from "vitest";
import { captureWebpackModules, findUniqueModule } from "../../src/compat/module-scanner.js";
import { SYNTHETIC_WEBPACK_BUNDLE } from "../fixtures/synthetic-webpack-bundle.js";

describe("Webpack module scanner", () => {
  it("captures factories without executing them and finds a unique anchor match", () => {
    const modules = captureWebpackModules(SYNTHETIC_WEBPACK_BUNDLE);
    expect([...modules.keys()]).toEqual(["alpha", "crypto", "media"]);

    const match = findUniqueModule(modules, [
      "ContentEnvelope",
      "EnvelopeEncryption",
      "FideliusEncryption",
    ]);
    expect(match).toMatchObject({
      id: "crypto",
      matchedAnchors: ["ContentEnvelope", "EnvelopeEncryption", "FideliusEncryption"],
    });
  });

  it("rejects zero and multiple anchor matches", () => {
    const modules = captureWebpackModules(SYNTHETIC_WEBPACK_BUNDLE);
    expect(() => findUniqueModule(modules, ["missing-anchor"])).toThrowError("Webpack module discovery failed");

    const duplicateSource = SYNTHETIC_WEBPACK_BUNDLE.replace(
      '"alpha": function(module) { module.exports = "unrelated"; }',
      '"alpha": function(module) { module.exports = ["ContentEnvelope", "EnvelopeEncryption", "FideliusEncryption"]; }',
    );
    expect(() =>
      findUniqueModule(captureWebpackModules(duplicateSource), [
        "ContentEnvelope",
        "EnvelopeEncryption",
        "FideliusEncryption",
      ]),
    ).toThrowError("Webpack module discovery failed");
  });

  it("enforces a source-size limit", () => {
    expect(() => captureWebpackModules("x".repeat(1025), { maxSourceBytes: 1024 })).toThrowError("Webpack module discovery failed");
  });
});
