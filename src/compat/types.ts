export type ModuleFactory = (
  module: { exports: unknown },
  exports: unknown,
  webpackRequire: (id: string) => unknown,
) => void;

export interface ModuleMatch {
  readonly id: string;
  readonly source: string;
  readonly matchedAnchors: readonly string[];
}

export interface CompatibilityReport {
  readonly buildId: "8dd50222";
  readonly assets: readonly {
    readonly filename: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly modules: readonly {
    readonly capability: string;
    readonly moduleId: string;
  }[];
  readonly wasmImports: readonly string[];
  readonly wasmExports: readonly string[];
}
