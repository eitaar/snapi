import { webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";
import { AppError } from "../errors.js";

export interface BrowserGlobalOptions {
  readonly origin: "https://www.snapchat.com";
  readonly userAgent: string;
  readonly localStorage: Readonly<Record<string, string>>;
}

export interface InstalledGlobals {
  readonly indexedDB: IDBFactory;
  readonly restore: () => void;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  constructor(initial: Readonly<Record<string, string>>) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

function browserBase64Decode(value: string): string {
  return Buffer.from(value, "base64").toString("latin1");
}

function browserBase64Encode(value: string): string {
  return Buffer.from(value, "latin1").toString("base64");
}

export function installBrowserGlobals(
  options: BrowserGlobalOptions,
  target: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>,
): InstalledGlobals {
  if (typeof globalThis.fetch !== "function" || typeof globalThis.WebSocket !== "function") {
    throw new AppError("CRYPTO_RUNTIME_FAILED", "Node browser-compatible networking APIs are unavailable");
  }
  const indexedDB = new IDBFactory();
  const values: Readonly<Record<string, unknown>> = {
    self: target,
    window: target,
    crypto: (globalThis.crypto ?? webcrypto) as Crypto,
    TextEncoder,
    TextDecoder,
    performance,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    atob: globalThis.atob ?? browserBase64Decode,
    btoa: globalThis.btoa ?? browserBase64Encode,
    localStorage: new MemoryStorage(options.localStorage),
    navigator: Object.freeze({ userAgent: options.userAgent }),
    location: Object.freeze({ origin: options.origin, href: `${options.origin}/web/` }),
    indexedDB,
    IDBCursor,
    IDBCursorWithValue,
    IDBDatabase,
    IDBFactory,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBOpenDBRequest,
    IDBRequest,
    IDBTransaction,
    IDBVersionChangeEvent,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(target, key));
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  let restored = false;
  return {
    indexedDB,
    restore: () => {
      if (restored) return;
      restored = true;
      for (const [key, descriptor] of [...previous.entries()].reverse()) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(target, key);
        } else {
          Object.defineProperty(target, key, descriptor);
        }
      }
    },
  };
}
