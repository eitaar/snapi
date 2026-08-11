import { AppError } from "../errors.js";
import type { AssetRecord, SessionExport } from "../session/types.js";
import type { AssetLoaderLike } from "./asset-loader.js";
import { inspectOfficialWorkerContract } from "./official-worker-contract.js";
import type { CompatibilityReport } from "./types.js";

export const SUPPORTED_ASSETS: readonly AssetRecord[] = [
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
] as const;

export interface CompatibilityInspection {
  readonly modules: readonly { readonly capability: string; readonly moduleId: string }[];
  readonly wasmImports: readonly string[];
  readonly wasmExports: readonly string[];
}

export interface CompatibilityProbe {
  inspect(assets: ReadonlyMap<string, Uint8Array>): Promise<CompatibilityInspection>;
}

class DefaultCompatibilityProbe implements CompatibilityProbe {
  async inspect(assets: ReadonlyMap<string, Uint8Array>): Promise<CompatibilityInspection> {
    const sources = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const record of SUPPORTED_ASSETS.filter(({ kind }) => kind === "javascript")) {
      const bytes = assets.get(record.filename);
      if (bytes === undefined) throw new AppError("UNSUPPORTED_BUILD", "Verified JavaScript asset missing");
      sources.set(record.filename, decoder.decode(bytes));
    }
    const modules = inspectOfficialWorkerContract(sources);
    const wasmRecord = SUPPORTED_ASSETS.find(({ kind }) => kind === "wasm")!;
    const wasmBytes = assets.get(wasmRecord.filename);
    if (wasmBytes === undefined) throw new AppError("UNSUPPORTED_BUILD", "Verified WASM asset missing");
    let wasmModule: WebAssembly.Module;
    try {
      wasmModule = new WebAssembly.Module(Uint8Array.from(wasmBytes));
    } catch {
      throw new AppError("UNSUPPORTED_BUILD", "WASM module is invalid");
    }
    const wasmImports = WebAssembly.Module.imports(wasmModule).map(({ module, name }) => `${module}.${name}`);
    const wasmExports = WebAssembly.Module.exports(wasmModule).map(({ name }) => name);
    if (wasmExports.length === 0) throw new AppError("UNSUPPORTED_BUILD", "WASM exports are empty");
    return {
      modules,
      wasmImports,
      wasmExports,
    };
  }
}

function assertManifest(session: SessionExport): void {
  const records = new Map<string, AssetRecord>();
  for (const record of session.assets) {
    if (records.has(record.filename)) {
      throw new AppError("UNSUPPORTED_BUILD", "Duplicate build asset record", {
        filename: record.filename,
      });
    }
    records.set(record.filename, record);
  }
  for (const expected of SUPPORTED_ASSETS) {
    const actual = records.get(expected.filename);
    if (
      actual === undefined ||
      actual.kind !== expected.kind ||
      actual.sha256 !== expected.sha256 ||
      actual.size !== expected.size
    ) {
      throw new AppError("UNSUPPORTED_BUILD", "Build asset manifest does not match", {
        filename: expected.filename,
      });
    }
  }
}

export class CompatibilityGuard {
  constructor(
    private readonly loader: AssetLoaderLike,
    private readonly probe: CompatibilityProbe = new DefaultCompatibilityProbe(),
  ) {}

  async verify(session: SessionExport): Promise<CompatibilityReport> {
    if (session.buildId !== "8dd50222") {
      throw new AppError("UNSUPPORTED_BUILD", "Unsupported Snapchat Web build", {
        buildId: session.buildId,
      });
    }
    assertManifest(session);
    const loaded = new Map<string, Uint8Array>();
    for (const record of SUPPORTED_ASSETS) {
      loaded.set(record.filename, await this.loader.loadVerified(record));
    }
    let inspection: CompatibilityInspection;
    try {
      inspection = await this.probe.inspect(loaded);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UNSUPPORTED_BUILD", "Build compatibility probe failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return {
      buildId: "8dd50222",
      assets: SUPPORTED_ASSETS.map(({ filename, sha256, size }) => ({ filename, sha256, size })),
      modules: inspection.modules,
      wasmImports: inspection.wasmImports,
      wasmExports: inspection.wasmExports,
    };
  }
}
