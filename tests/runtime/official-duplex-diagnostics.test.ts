import { describe, expect, it } from "vitest";
import {
  describeOfficialDuplexCause,
  instrumentOfficialDuplexErrors,
  registerOfficialMainAssetWithWorkerExports,
  waitForOfficialBootstrapRegistration,
} from "../../src/runtime/official-duplex-diagnostics.js";

describe("official duplex diagnostics", () => {
  it("classifies a hidden non-callable cause without retaining its raw message", () => {
    const error = new TypeError("secretCallback is not a function");
    error.stack = "TypeError: secretCallback is not a function\n    at fn (4577c38d10436a1f90f1.chunk.js:1:48123)";

    expect(describeOfficialDuplexCause(error)).toBe("TypeError:not-callable@1:48123");
    expect(describeOfficialDuplexCause(error)).not.toContain("secretCallback");
  });

  it("identifies a missing property without retaining the raw exception message", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'INACTIVE')");
    error.stack = "TypeError: hidden\n    at fn (4577c38d10436a1f90f1.chunk.js:1:45869)";

    expect(describeOfficialDuplexCause(error)).toBe("TypeError:missing-property-INACTIVE@1:45869");
    expect(describeOfficialDuplexCause(error)).not.toContain("Cannot read");
  });

  it("instruments the pinned duplex error without changing unrelated source", () => {
    const source = 'before,new Error("failed to create duplex client",{cause:e}),after';

    expect(instrumentOfficialDuplexErrors(source)).toBe(
      'before,new Error("failed to create duplex client ["+globalThis.__officialDescribeDuplexCause(e)+"]",{cause:e}),after',
    );
  });

  it("lets dynamic chunk startup finish before main asset registration", async () => {
    let dynamicChunkRegistered = false;
    Promise.resolve().then(() => { dynamicChunkRegistered = true; });

    await waitForOfficialBootstrapRegistration();

    expect(dynamicChunkRegistered).toBe(true);
  });

  it("combines main exports with worker-only exports for colliding module ids", () => {
    type Factory = (module: { exports: Record<string, string> }, exports: Record<string, string>) => void;
    const workerFactory: Factory = (_module, exports) => {
      exports.shared = "worker";
      exports.workerOnly = "worker";
    };
    const modules: Record<string, Factory> = { "20606": workerFactory };

    registerOfficialMainAssetWithWorkerExports(modules, ["20606"], () => {
      modules["20606"] = (_module, exports) => {
        exports.shared = "main";
        exports.mainOnly = "main";
      };
    });

    const loaded = { exports: {} as Record<string, string> };
    modules["20606"]!(loaded, loaded.exports);
    expect(loaded.exports).toEqual({
      shared: "main",
      mainOnly: "main",
      workerOnly: "worker",
    });
  });
});
