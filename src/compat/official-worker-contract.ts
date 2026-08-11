import { AppError } from "../errors.js";

const REQUIRED_SOURCE_ANCHORS = {
  "41f8a232e0dafca526c7.js": [
    "createMessagingSession",
    "getConversationManager",
    "getFeedManager",
  ],
  "4577c38d10436a1f90f1.chunk.js": [
    "73843",
    "dw/269b973c69f9ca2dcc93.chunk.js",
    "setAuthTokenGetter",
    "setMcsCofSequenceIdsGetter",
    "loadWasm",
    "createMessagingSession",
    "registerDuplexHandler",
  ],
  "269b973c69f9ca2dcc93.chunk.js": [
    "7818",
    "dw/903641c0ba985b2dcd13.wasm",
  ],
} as const;

export interface OfficialWorkerModule {
  readonly capability: "messaging-wasm-worker";
  readonly moduleId: "73843";
}

export function inspectOfficialWorkerContract(
  sources: ReadonlyMap<string, string>,
): readonly OfficialWorkerModule[] {
  for (const [filename, anchors] of Object.entries(REQUIRED_SOURCE_ANCHORS)) {
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
