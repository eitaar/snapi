import { runInNewContext } from "node:vm";
import { AppError } from "../errors.js";
import type { ModuleFactory, ModuleMatch } from "./types.js";

export interface ModuleScannerOptions {
  readonly maxSourceBytes?: number;
  readonly timeoutMs?: number;
}

function unsupported(reason: string, details: Readonly<Record<string, unknown>> = {}): AppError {
  return new AppError("UNSUPPORTED_BUILD", "Webpack module discovery failed", {
    reason,
    ...details,
  });
}

function captureChunk(value: unknown, modules: Map<string, ModuleFactory>): void {
  if (!Array.isArray(value) || value.length < 2) return;
  const registry = value[1];
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) return;
  for (const [id, factory] of Object.entries(registry)) {
    if (typeof factory !== "function") continue;
    modules.set(id, factory as ModuleFactory);
  }
}

export function captureWebpackModules(
  source: string,
  options: ModuleScannerOptions = {},
): Map<string, ModuleFactory> {
  const maxSourceBytes = options.maxSourceBytes ?? 20 * 1024 * 1024;
  if (new TextEncoder().encode(source).length > maxSourceBytes) {
    throw unsupported("bundle source is too large", { maxSourceBytes });
  }
  const modules = new Map<string, ModuleFactory>();
  const registry = Object.freeze({
    push: (chunk: unknown): number => {
      captureChunk(chunk, modules);
      return modules.size;
    },
  });
  const globals: Record<string, unknown> = {};
  const chunkGlobals = new Set(
    [...source.matchAll(/\bwebpackChunk[A-Za-z0-9_$]+\b/g)].map(([name]) => name),
  );
  if (chunkGlobals.size === 0) {
    throw unsupported("bundle does not declare a webpack chunk registry");
  }
  for (const name of chunkGlobals) globals[name] = registry;
  globals.self = globals;
  globals.window = globals;
  globals.crypto = globalThis.crypto;
  globals.TextDecoder = TextDecoder;
  globals.TextEncoder = TextEncoder;
  globals.URL = URL;
  globals.URLSearchParams = URLSearchParams;
  globals.Blob = Blob;
  globals.atob = atob;
  globals.btoa = btoa;
  globals.performance = performance;
  globals.addEventListener = () => undefined;
  globals.removeEventListener = () => undefined;
  globals.dispatchEvent = () => true;
  globals.Event = Event;
  globals.CustomEvent = CustomEvent;
  globals.navigator = { userAgent: "Mozilla/5.0", onLine: true };
  globals.location = {
    origin: "https://web.snapchat.com",
    href: "https://web.snapchat.com/web/",
    pathname: "/web/",
  };
  globals.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({
      style: {},
      setAttribute: () => undefined,
      appendChild: () => undefined,
      remove: () => undefined,
    }),
  };
  globals.console = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    log: () => undefined,
    warn: () => undefined,
  };

  try {
    runInNewContext(source, globals, {
      timeout: options.timeoutMs ?? 250,
      microtaskMode: "afterEvaluate",
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (error) {
    throw unsupported("bundle registration did not execute safely", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return modules;
}

export function findUniqueModule(
  modules: ReadonlyMap<string, ModuleFactory>,
  anchors: readonly string[],
): ModuleMatch {
  if (anchors.length === 0 || anchors.some((anchor) => anchor.length === 0)) {
    throw unsupported("anchor set must not be empty");
  }
  const matches: ModuleMatch[] = [];
  for (const [id, factory] of modules) {
    const source = Function.prototype.toString.call(factory);
    const matchedAnchors = anchors.filter((anchor) => source.includes(anchor));
    if (matchedAnchors.length === anchors.length) matches.push({ id, source, matchedAnchors });
  }
  if (matches.length !== 1) {
    throw unsupported("module anchors did not produce a unique match", {
      anchors,
      matchCount: matches.length,
      matchingIds: matches.map(({ id }) => id),
    });
  }
  return matches[0]!;
}
