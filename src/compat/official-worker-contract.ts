import { AppError } from "../errors.js";
import type { BuildProfile } from "../builds.js";

const DEFAULT_CONTRACT = {
  mainAsset: "41f8a232e0dafca526c7.js",
  bootstrapAsset: "4577c38d10436a1f90f1.chunk.js",
  dynamicChunkAsset: "269b973c69f9ca2dcc93.chunk.js",
  wasmAsset: "903641c0ba985b2dcd13.wasm",
} as const;

interface OfficialWorkerContractProfile {
  readonly mainAsset: string;
  readonly bootstrapAsset: string;
  readonly dynamicChunkAsset: string;
  readonly wasmAsset: string;
}

function requiredSourceAnchors(profile: OfficialWorkerContractProfile): Readonly<Record<string, readonly string[]>> {
  return {
  [profile.mainAsset]: [
    "createMessagingSession",
    "getConversationManager",
    "getFeedManager",
  ],
  [profile.bootstrapAsset]: [
    "73843",
    `dw/${profile.dynamicChunkAsset}`,
    "setAuthTokenGetter",
    "setMcsCofSequenceIdsGetter",
    "loadWasm",
    "createMessagingSession",
    "registerDuplexHandler",
  ],
  [profile.dynamicChunkAsset]: [
    "7818",
    `dw/${profile.wasmAsset}`,
  ],
  };
}

export interface OfficialWorkerModule {
  readonly capability: "messaging-wasm-worker";
  readonly moduleId: "73843";
}

export function inspectOfficialWorkerContract(
  sources: ReadonlyMap<string, string>,
  profile: OfficialWorkerContractProfile | BuildProfile["officialWorker"] = DEFAULT_CONTRACT,
): readonly OfficialWorkerModule[] {
  for (const [filename, anchors] of Object.entries(requiredSourceAnchors(profile))) {
    const source = sources.get(filename);
    if (source === undefined) {
      throw new AppError("UNSUPPORTED_BUILD", "Official messaging Worker asset is missing", { filename });
    }
    const missingAnchors = anchors.filter((anchor) => !source.includes(anchor));
    if (missingAnchors.length > 0) {
      throw new AppError("UNSUPPORTED_BUILD", "Official messaging Worker contract does not match", {
        filename,
        missingAnchors,
      });
    }
  }
  return [{ capability: "messaging-wasm-worker", moduleId: "73843" }];
}
