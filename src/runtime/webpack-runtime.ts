import { AppError } from "../errors.js";
import type { ModuleFactory } from "../compat/types.js";

type WebpackRequire = ((id: string | number) => unknown) & {
  d: (
    exports: object,
    definitions: Readonly<Record<string, () => unknown>> | readonly unknown[],
  ) => void;
  r: (exports: object) => void;
  o: (value: object, property: PropertyKey) => boolean;
  n: (value: unknown) => (() => unknown) & { a?: () => unknown };
  nmd: <T>(module: T) => T;
  g: typeof globalThis;
};

export interface WebpackRuntime {
  readonly require: (id: string | number) => unknown;
}

export function rebindWebpackFactories(
  factories: ReadonlyMap<string, ModuleFactory>,
): ReadonlyMap<string, ModuleFactory> {
  const rebound = new Map<string, ModuleFactory>();
  for (const [id, factory] of factories) {
    const source = factory.toString();
    const parametersStart = source.indexOf("(");
    const parametersEnd = source.indexOf(")", parametersStart + 1);
    const bodyStart = source.indexOf("{", parametersEnd + 1);
    if (parametersStart < 0 || parametersEnd < 0 || bodyStart < 0 || !source.endsWith("}")) {
      throw new AppError("UNSUPPORTED_BUILD", "Webpack factory source has an unsupported shape", {
        moduleId: id,
      });
    }
    const parameters = source.slice(parametersStart + 1, parametersEnd)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (parameters.some((value) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value))) {
      throw new AppError("UNSUPPORTED_BUILD", "Webpack factory parameters are invalid", {
        moduleId: id,
      });
    }
    try {
      const created = new Function(...parameters, source.slice(bodyStart + 1, -1)) as ModuleFactory;
      rebound.set(id, created);
    } catch {
      throw new AppError("UNSUPPORTED_BUILD", "Webpack factory could not be rebound", {
        moduleId: id,
      });
    }
  }
  return rebound;
}

export function createWebpackRuntime(
  factories: ReadonlyMap<string, ModuleFactory>,
  stubs: ReadonlyMap<string, unknown> = new Map(),
): WebpackRuntime {
  const cache = new Map<string, { exports: unknown }>();
  for (const [id, exports] of stubs) cache.set(id, { exports });
  const require = ((rawId: string | number): unknown => {
    const id = String(rawId);
    const cached = cache.get(id);
    if (cached !== undefined) return cached.exports;
    const factory = factories.get(id);
    if (factory === undefined) {
      throw new AppError("UNSUPPORTED_BUILD", "Webpack dependency is missing", { moduleId: id });
    }
    const module = { exports: {} as unknown };
    cache.set(id, module);
    try {
      factory(module, module.exports, require as unknown as (id: string) => unknown);
    } catch (error) {
      cache.delete(id);
      if (error instanceof AppError) throw error;
      throw new AppError("UNSUPPORTED_BUILD", "Webpack module failed during initialization", {
        moduleId: id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return module.exports;
  }) as WebpackRequire;
  require.d = (exports, definitions) => {
    if (Array.isArray(definitions)) {
      for (let index = 0; index + 1 < definitions.length;) {
        const name = definitions[index];
        const descriptor = definitions[index + 1];
        index += 2;
        if (typeof name !== "string" || (descriptor !== 0 && typeof descriptor !== "function")) {
          throw new AppError("UNSUPPORTED_BUILD", "Webpack export getter table is invalid");
        }
        if (!Object.prototype.hasOwnProperty.call(exports, name)) {
          if (descriptor === 0) {
            Object.defineProperty(exports, name, {
              enumerable: true,
              value: definitions[index],
            });
            index += 1;
          } else {
            Object.defineProperty(exports, name, { enumerable: true, get: descriptor });
          }
        } else if (descriptor === 0) {
          index += 1;
        }
      }
      return;
    }
    const objectDefinitions = definitions as Readonly<Record<string, () => unknown>>;
    for (const [name, getter] of Object.entries(objectDefinitions)) {
      if (!Object.prototype.hasOwnProperty.call(exports, name)) {
        Object.defineProperty(exports, name, { enumerable: true, get: getter });
      }
    }
  };
  require.r = (exports) => {
    Object.defineProperty(exports, "__esModule", { value: true });
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  };
  require.o = (value, property) => Object.prototype.hasOwnProperty.call(value, property);
  require.n = (value) => {
    const getter = (() =>
      value !== null && typeof value === "object" && "__esModule" in value
        ? (value as unknown as { readonly default: unknown }).default
        : value) as (() => unknown) & { a?: () => unknown };
    getter.a = getter;
    return getter;
  };
  require.nmd = (module) => module;
  require.g = globalThis;
  return { require };
}
