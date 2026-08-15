import { AppError } from "../errors.js";
import type { BrowserStateSnapshot } from "../session/browser-export.js";

export interface CaptureBrowserStateOptions {
  readonly cdpUrl: string;
  readonly targetUrl: string;
  readonly timeoutMs?: number;
}

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface CdpReply<T> {
  readonly id: number;
  readonly result?: T;
  readonly error?: { readonly message?: string };
}

interface RuntimeEvaluateResult {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

const BROWSER_STATE_SCRIPT = `
(async () => {
  const bytesToBase64 = (bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const encode = (value, seen = new WeakSet()) => {
    if (value instanceof ArrayBuffer) return { $bytes: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      return { $bytes: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map((entry) => encode(entry, seen));
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) throw new Error("cyclic IndexedDB value");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value)) result[key] = encode(value[key], seen);
      seen.delete(value);
      return result;
    }
    return value;
  };
  const storageSnapshot = (storage) => {
    const result = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) result[key] = storage.getItem(key) ?? "";
    }
    return result;
  };
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
  const readStore = (database, name) => new Promise((resolve, reject) => {
    const transaction = database.transaction(name, "readonly");
    const store = transaction.objectStore(name);
    const records = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({
          name: store.name,
          keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            return {
              name: index.name,
              keyPath: Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            };
          }),
          records,
        });
        return;
      }
      records.push({ key: encode(cursor.primaryKey), value: encode(cursor.value) });
      cursor.continue();
    };
  });
  const databases = [];
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const database = await requestResult(indexedDB.open(info.name));
    try {
      const stores = [];
      for (const name of [...database.objectStoreNames]) stores.push(await readStore(database, name));
      databases.push({ name: database.name, version: database.version, stores });
    } finally {
      database.close();
    }
  }
  return {
    pageUrl: location.href,
    localStorage: storageSnapshot(localStorage),
    sessionStorage: storageSnapshot(sessionStorage),
    indexedDb: { databases },
  };
})()
`;

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("error", () => this.failAll(new Error("CDP WebSocket error")));
    socket.addEventListener("close", () => this.failAll(new Error("CDP WebSocket closed")));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    if (typeof globalThis.WebSocket !== "function") {
      throw new AppError("INVALID_CONFIG", "This Node runtime has no WebSocket client for CDP");
    }
    const socket = new globalThis.WebSocket(url);
    const connection = new CdpConnection(socket, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Unable to open CDP WebSocket"));
      }, { once: true });
    }).catch((error) => {
      socket.close();
      throw new AppError("INVALID_CONFIG", "Unable to connect to the local browser CDP endpoint", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
    return connection;
  }

  async send<T>(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.failAll(new Error("CDP connection closed"));
    this.socket.close();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let message: CdpReply<unknown>;
    try {
      message = JSON.parse(data) as CdpReply<unknown>;
    } catch {
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const request = this.pending.get(message.id);
    if (request === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new Error(message.error.message ?? "CDP command failed"));
    } else {
      request.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

async function listTargets(cdpUrl: string): Promise<readonly CdpTarget[]> {
  let response: Response;
  try {
    response = await fetch(new URL("/json/list", cdpUrl));
  } catch {
    throw new AppError("INVALID_CONFIG", "Unable to reach the local browser CDP endpoint");
  }
  if (!response.ok) {
    throw new AppError("INVALID_CONFIG", "Local browser CDP endpoint returned an error", {
      status: response.status,
    });
  }
  try {
    const value = await response.json() as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is CdpTarget =>
      entry !== null && typeof entry === "object") : [];
  } catch {
    throw new AppError("INVALID_CONFIG", "Local browser CDP endpoint returned invalid target data");
  }
}

function assertSafeCaptureTargets(cdpUrl: string, targetUrl: string): URL {
  let cdp: URL;
  let target: URL;
  try {
    cdp = new URL(cdpUrl);
    target = new URL(targetUrl);
  } catch {
    throw new AppError("INVALID_CONFIG", "CDP and target URLs must be valid URLs");
  }
  if (cdp.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(cdp.hostname)) {
    throw new AppError("INVALID_CONFIG", "Browser export only permits a local CDP endpoint");
  }
  if (!["https://web.snapchat.com", "https://www.snapchat.com"].includes(target.origin)) {
    throw new AppError("INVALID_CONFIG", "Browser export target must be a Snapchat Web origin");
  }
  return target;
}

export async function captureBrowserState(
  options: CaptureBrowserStateOptions,
): Promise<BrowserStateSnapshot> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const targetOrigin = assertSafeCaptureTargets(options.cdpUrl, options.targetUrl).origin;
  const target = (await listTargets(options.cdpUrl)).find((candidate) =>
    candidate.type === "page" &&
    candidate.webSocketDebuggerUrl !== undefined &&
    candidate.url !== undefined &&
    new URL(candidate.url).origin === targetOrigin,
  );
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new AppError("SESSION_LOGIN_REQUIRED", "No matching logged-in Snapchat tab was found in CDP");
  }
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    const evaluated = await connection.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression: BROWSER_STATE_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = evaluated.result?.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError("SESSION_REEXPORT_REQUIRED", "Browser did not return a session state snapshot");
    }
    const snapshot = value as BrowserStateSnapshot;
    if (
      snapshot.localStorage === undefined ||
      snapshot.sessionStorage === undefined ||
      snapshot.indexedDb === undefined
    ) {
      throw new AppError("SESSION_REEXPORT_REQUIRED", "Browser session state snapshot is incomplete");
    }
    if (snapshot.pageUrl !== undefined && new URL(snapshot.pageUrl).origin !== targetOrigin) {
      throw new AppError("SESSION_LOGIN_REQUIRED", "The selected browser tab navigated away from Snapchat Web");
    }
    return snapshot;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Unable to capture browser session state", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  } finally {
    connection.close();
  }
}
