const DUPLEX_ERROR = 'new Error("failed to create duplex client",{cause:e})';
const INSTRUMENTED_DUPLEX_ERROR =
  'new Error("failed to create duplex client ["+globalThis.__officialDescribeDuplexCause(e)+"]",{cause:e})';

function category(message: string): string {
  const missingProperty = /reading ['"]([A-Za-z_$][A-Za-z0-9_$]{0,40})['"]/.exec(message);
  if (missingProperty !== null) return `missing-property-${missingProperty[1]}`;
  if (/not a function|not callable/i.test(message)) return "not-callable";
  if (/undefined|null/i.test(message)) return "missing-value";
  if (/websocket/i.test(message)) return "websocket";
  if (/subscribe/i.test(message)) return "observable";
  if (/alloc|memory/i.test(message)) return "wasm-memory";
  return "unclassified";
}

export function describeOfficialDuplexCause(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
    ? error.name
    : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const location = /4577c38d10436a1f90f1\.chunk\.js:(\d+):(\d+)/.exec(stack);
  return `${name}:${category(message)}${location === null ? "" : `@${location[1]}:${location[2]}`}`;
}

export function instrumentOfficialDuplexErrors(source: string): string {
  return source.replace(DUPLEX_ERROR, INSTRUMENTED_DUPLEX_ERROR);
}

type OfficialModule = { exports: unknown };
type OfficialModuleFactory = (
  this: unknown,
  module: OfficialModule,
  exports: unknown,
  require: unknown,
) => void;

export function registerOfficialMainAssetWithWorkerExports(
  modules: Record<string, unknown>,
  moduleIds: readonly string[],
  registerMainAsset: () => void,
): void {
  const workerFactories = new Map<string, OfficialModuleFactory>();
  for (const moduleId of moduleIds) {
    const factory = modules[moduleId];
    if (typeof factory !== "function") {
      throw new Error("Official worker module is unavailable before main asset registration");
    }
    workerFactories.set(moduleId, factory as OfficialModuleFactory);
  }
  registerMainAsset();
  for (const [moduleId, workerFactory] of workerFactories) {
    const mainFactory = modules[moduleId];
    if (typeof mainFactory !== "function") {
      throw new Error("Official main module is unavailable after asset registration");
    }
    modules[moduleId] = function(
      this: unknown,
      module: OfficialModule,
      exports: unknown,
      require: unknown,
    ): void {
      (mainFactory as OfficialModuleFactory).call(this, module, exports, require);
      const workerModule: OfficialModule = { exports: {} };
      workerFactory.call(this, workerModule, workerModule.exports, require);
      if (
        (typeof module.exports !== "object" && typeof module.exports !== "function") ||
        module.exports === null ||
        (typeof workerModule.exports !== "object" && typeof workerModule.exports !== "function") ||
        workerModule.exports === null
      ) {
        throw new Error("Official colliding module exports are not mergeable");
      }
      const mainExports = module.exports as Record<PropertyKey, unknown>;
      for (const key of Reflect.ownKeys(workerModule.exports)) {
        if (Object.prototype.hasOwnProperty.call(mainExports, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(workerModule.exports, key);
        if (descriptor !== undefined) Object.defineProperty(mainExports, key, descriptor);
      }
    };
  }
}

export async function waitForOfficialBootstrapRegistration(): Promise<void> {
  await Promise.resolve();
}
