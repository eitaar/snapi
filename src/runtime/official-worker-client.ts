import { MessageChannel, MessagePort, Worker, type TransferListItem } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { SessionExport } from "../session/types.js";
import type { IncomingSnapMediaInfo } from "./content-types.js";
import { syncOfficialFriends } from "./official-host-control.js";
import type { FriendSnapshot } from "../friends/types.js";
import type { RuntimeAuthUpdate } from "./protocol.js";
import { OFFICIAL_SESSION_EXPIRED_ERROR_NAME } from "./official-auth-failure.js";

interface SerializedValue {
  readonly type: "RAW" | "HANDLER";
  readonly name?: "proxy" | "throw";
  readonly value: unknown;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
}

class OfficialExposedValue {
  constructor(readonly value: object) {}
}

export function exposeOfficial<T extends object>(value: T): unknown {
  return new OfficialExposedValue(value);
}

function deserializeArguments(
  values: readonly SerializedValue[],
  callbackPorts: Set<MessagePort>,
  remotePorts: Set<MessagePort>,
): unknown[] {
  return values.map((entry) => {
    if (entry.type === "HANDLER" && entry.name === "proxy" && entry.value instanceof MessagePort) {
      return new OfficialRemote(entry.value, callbackPorts, remotePorts);
    }
    return entry.value;
  });
}

function thrownValue(error: unknown): SerializedValue {
  return {
    type: "HANDLER",
    name: "throw",
    value: {
      isError: true,
      value: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Callback failed",
      },
    },
  };
}

function createExposedProxy(
  exposed: object,
  callbackPorts: Set<MessagePort>,
  remotePorts: Set<MessagePort>,
): readonly [SerializedValue, MessagePort] {
  const { port1, port2 } = new MessageChannel();
  callbackPorts.add(port2);
  port2.on("message", async (message: {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly path?: readonly string[];
    readonly argumentList?: readonly SerializedValue[];
    readonly value?: SerializedValue;
  }) => {
    if (typeof message.id !== "string") return;
    try {
      const path = message.path ?? [];
      const owner = path.slice(0, -1).reduce<unknown>((value, key) =>
        (value as Record<string, unknown>)[key], exposed);
      const selected = path.reduce<unknown>((value, key) =>
        (value as Record<string, unknown>)[key], exposed);
      let result: unknown;
      switch (message.type) {
        case "GET":
          result = selected;
          break;
        case "SET": {
          const key = path.at(-1);
          if (key === undefined || owner === null || typeof owner !== "object") {
            throw new TypeError("Cannot set an empty official proxy path");
          }
          (owner as Record<string, unknown>)[key] = message.value?.value;
          result = true;
          break;
        }
        case "APPLY":
          if (typeof selected !== "function") throw new TypeError("Official proxy path is not callable");
          result = await selected.apply(owner, deserializeArguments(
            message.argumentList ?? [],
            callbackPorts,
            remotePorts,
          ));
          break;
        case "RELEASE":
          result = undefined;
          break;
        default:
          throw new TypeError("Unsupported official proxy operation");
      }
      if (result instanceof OfficialExposedValue || typeof result === "function") {
        const nested = result instanceof OfficialExposedValue ? result.value : result;
        const [wireValue, port] = createExposedProxy(nested as object, callbackPorts, remotePorts);
        port2.postMessage({ id: message.id, ...wireValue }, [port]);
      } else {
        port2.postMessage({ id: message.id, type: "RAW", value: result });
      }
    } catch (error) {
      port2.postMessage({ id: message.id, ...thrownValue(error) });
    }
    if (message.type === "RELEASE") {
      callbackPorts.delete(port2);
      port2.close();
    }
  });
  port2.start();
  return [{ type: "HANDLER", name: "proxy", value: port1 }, port1] as const;
}

function createCallbackProxy(
  callback: (...args: unknown[]) => unknown,
  callbackPorts: Set<MessagePort>,
  remotePorts: Set<MessagePort>,
): readonly [SerializedValue, MessagePort] {
  return createExposedProxy(callback, callbackPorts, remotePorts);
}

function serializeArguments(
  args: readonly unknown[],
  callbackPorts: Set<MessagePort>,
  remotePorts: Set<MessagePort>,
): readonly [readonly SerializedValue[], readonly TransferListItem[]] {
  const transferList: TransferListItem[] = [];
  const argumentList = args.map((arg): SerializedValue => {
    if (arg instanceof OfficialExposedValue) {
      const [value, port] = createExposedProxy(arg.value, callbackPorts, remotePorts);
      transferList.push(port);
      return value;
    }
    if (typeof arg === "function") {
      const [value, port] = createCallbackProxy(
        arg as (...args: unknown[]) => unknown,
        callbackPorts,
        remotePorts,
      );
      transferList.push(port);
      return value;
    }
    return { type: "RAW", value: arg };
  });
  return [argumentList, transferList];
}

export class OfficialRemote {
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly endpoint: MessagePort,
    private readonly callbackPorts: Set<MessagePort>,
    private readonly remotePorts: Set<MessagePort>,
  ) {
    remotePorts.add(endpoint);
    endpoint.on("message", (value: unknown) => this.handleMessage(value));
    endpoint.start();
  }

  private handleMessage(value: unknown): void {
    if (value === null || typeof value !== "object" || !("id" in value)) return;
    const response = value as {
      readonly id: unknown;
      readonly type?: unknown;
      readonly name?: unknown;
      readonly value?: unknown;
    };
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (response.type === "RAW") {
      pending.resolve(response.value);
      return;
    }
    if (response.type === "HANDLER" && response.name === "proxy" && response.value instanceof MessagePort) {
      pending.resolve(new OfficialRemote(response.value, this.callbackPorts, this.remotePorts));
      return;
    }
    const thrown = response.value as { readonly value?: { readonly name?: string; readonly message?: string } } | undefined;
    if (thrown?.value?.name === OFFICIAL_SESSION_EXPIRED_ERROR_NAME) {
      pending.reject(new AppError(
        "SESSION_EXPIRED",
        "Official friend synchronization was unauthorized",
      ));
      return;
    }
    pending.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker call failed", {
      errorName: thrown?.value?.name ?? "UnknownError",
      safeMessage: thrown?.value?.message ?? "Worker call failed",
    }));
  }

  call<T>(path: readonly string[], args: readonly unknown[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging proxy is closed"));
    const id = String(this.nextId++);
    const [argumentList, transferList] = serializeArguments(
      args,
      this.callbackPorts,
      this.remotePorts,
    );
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.endpoint.postMessage({ id, type: "APPLY", path, argumentList }, transferList);
    });
  }

  async callRemote(path: readonly string[], args: readonly unknown[] = []): Promise<OfficialRemote> {
    const result = await this.call<unknown>(path, args);
    if (!(result instanceof OfficialRemote)) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker did not return a proxy");
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging proxy is closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.remotePorts.delete(this.endpoint);
    this.endpoint.close();
  }
}

function uuidValue(value: string): { readonly id: Uint8Array; readonly str: string } {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new AppError("SESSION_REEXPORT_REQUIRED", "Messaging account ID must be a UUID");
  }
  return {
    id: Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))),
    str: value.toLowerCase(),
  };
}

function uuidString(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { readonly id?: unknown; readonly str?: unknown };
  if (typeof candidate.str === "string") return candidate.str.toLowerCase();
  if (!(candidate.id instanceof Uint8Array) || candidate.id.length !== 16) return undefined;
  const hex = [...candidate.id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function byteValue(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function storageDelegate(values: Map<string, string>): object {
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    removeItem: async (key: string) => { values.delete(key); },
    setItem: async (key: string, value: string) => { values.set(key, value); },
    keys: async () => [...values.keys()],
  };
}

export interface OfficialMessagingStateExport {
  readonly localStorage: Readonly<Record<string, string>>;
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly rootWrappingKey?: {
    readonly data: string;
    readonly identityKeyId: string;
  };
}

interface MessagingArgumentBundle {
  readonly args: readonly unknown[];
  readonly exportState: () => OfficialMessagingStateExport;
}

function messagingArguments(
  session: SessionExport,
  injectedContentDelegate?: object,
  onMessage: (message: unknown) => unknown = () => undefined,
  injectedFeedDelegate?: object,
  injectedConversationDelegate?: object,
): MessagingArgumentBundle {
  const messaging = session.messaging;
  if (messaging === undefined) {
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing login-time messaging key initialization state",
    );
  }
  const userId = uuidValue(session.accountId);
  const localStorageValues = new Map(Object.entries(session.localStorage));
  const sessionStorageValues = new Map(Object.entries(session.sessionStorage ?? {}));
  let rootWrappingKey = messaging.rootWrappingKey === undefined
    ? undefined
    : {
        rwk: { data: byteValue(messaging.rootWrappingKey.data) },
        keyIdentifier: { data: byteValue(messaging.rootWrappingKey.identityKeyId) },
      };
  const rootWrappingKeyStore = {
    get: async () => rootWrappingKey,
    set: async (value: NonNullable<typeof rootWrappingKey>) => { rootWrappingKey = value; },
    subscribe: async () => undefined,
    purge: async () => undefined,
  };
  const noop = () => undefined;
  const conversationDelegate = injectedConversationDelegate ?? {
    onConversationCreated: noop,
    onConversationUpdated: noop,
    onSendStarted: noop,
    onSendComplete: noop,
    onConversationRemoved: noop,
    onConversationCreationServerConfirmed: noop,
    onConversationReset: noop,
  };
  const feedDelegate = injectedFeedDelegate ?? {
    onFeedEntriesUpdated: noop,
    onInternalSyncFeed: noop,
    onFeedRequestError: noop,
  };
  const contentDelegate = injectedContentDelegate ?? { uploadMedia: noop, uploadMediaReferences: noop };
  const mediaDelegate = { onMediaContentExpired: noop, onMediaPrefetchComplete: noop };
  const friendLinkDelegate = { fetchFriendLink: noop, fetchSnapchatterInfos: noop };
  const groupDelegate = { onGroupsUpdated: noop, onTopGroupsUpdated: noop };
  const adsDelegate = {
    onAdRequestBuildStart: noop,
    onAdRequestBuildSuccess: noop,
    onAdResponseSuccess: noop,
    onFeedEntered: noop,
    onSponsoredSnapHidden: noop,
    onSponsoredSnapInserted: noop,
    buildAdRequest: noop,
    onSponsoredSnapBannerInserted: noop,
    onSponsoredSnapBannerHidden: noop,
  };
  const tweaks = new Map<number, string>([
    [1, "noop"],
    [17, "CUSTOM"],
    [18, "https://web.snapchat.com"],
    [29, "30000"],
    [31, "100"],
    [45, "0"],
    [69, "false"],
    [91, "true"],
    [143, "true"],
    [144, "true"],
    [145, "true"],
    [157, "true"],
  ]);
  const config = {
    databaseLocation: ":memory:",
    userId,
    userAgentPrefix: "",
    debug: false,
    tweaks: { tweaks },
  };
  const friendDevices = (candidate: unknown) => {
    const id = uuidString(candidate);
    return id === undefined ? undefined : messaging.friendDevices[id];
  };
  const args = [
    config,
    exposeOfficial(conversationDelegate),
    exposeOfficial(feedDelegate),
    exposeOfficial(contentDelegate),
    exposeOfficial(mediaDelegate),
    exposeOfficial(friendLinkDelegate),
    exposeOfficial(onMessage),
    exposeOfficial(rootWrappingKeyStore),
    exposeOfficial(storageDelegate(localStorageValues)),
    exposeOfficial(storageDelegate(sessionStorageValues)),
    exposeOfficial(friendDevices),
    exposeOfficial(() => messaging.keyInitializationInfo === undefined
      ? undefined
      : byteValue(messaging.keyInitializationInfo)),
    exposeOfficial(groupDelegate),
    exposeOfficial(async () => undefined),
    exposeOfficial(adsDelegate),
    userId,
    exposeOfficial({ observeProperty: noop }),
    { ENABLE_EEL_FALLBACK_KEY_REMOVAL: false, ENABLE_IDENTITY_KEY_WRAPPING_FIX: false },
  ];
  return {
    args,
    exportState: () => ({
      localStorage: Object.fromEntries(localStorageValues),
      sessionStorage: Object.fromEntries(sessionStorageValues),
      ...(rootWrappingKey === undefined ? {} : {
        rootWrappingKey: {
          data: Buffer.from(rootWrappingKey.rwk.data).toString("base64"),
          identityKeyId: Buffer.from(rootWrappingKey.keyIdentifier.data).toString("base64"),
        },
      }),
    }),
  };
}

export interface OfficialWorkerClientOptions {
  readonly assetDir: string;
  readonly workerUrl?: URL;
  readonly allowNetwork?: boolean;
  readonly contentDelegate?: object;
  readonly onMessage?: (message: unknown) => unknown;
  readonly feedDelegate?: object;
  readonly conversationDelegate?: object;
}

export interface OfficialResolvedMediaLayer {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly hasAudio: boolean;
}

export class OfficialWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingCall>();
  private readonly callbackPorts = new Set<MessagePort>();
  private readonly remotePorts = new Set<MessagePort>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: AppError) => void;
  private readySettled = false;
  private nextId = 1;
  private closed = false;

  private exportMessagingStateSnapshot: (() => OfficialMessagingStateExport) | undefined;
  private feedManager: OfficialRemote | undefined;
  private accountId: string | undefined;
  private requestAuthState = {
    httpToken: "",
    mcsCofSequenceIds: "",
  };
  constructor(private readonly options: OfficialWorkerClientOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(options.workerUrl ?? new URL("./official-worker-entry.js", import.meta.url), {
      workerData: { assetDir: options.assetDir, allowNetwork: options.allowNetwork === true },
    });
    this.worker.on("message", (value: unknown) => this.handleMessage(value));
    this.worker.once("error", (error) => this.failAll(new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Official messaging Worker failed",
      { errorName: error.name },
    )));
    this.worker.once("exit", (code) => {
      if (!this.closed) {
        this.failAll(new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker exited", { exitCode: code }));
      }
    });
  }

  private handleMessage(value: unknown): void {
    if (value !== null && typeof value === "object" && "__officialHostReady" in value) {
      this.readySettled = true;
      this.resolveReady();
      return;
    }
    if (value === null || typeof value !== "object" || !("id" in value)) return;
    const response = value as { readonly id: unknown; readonly type?: unknown; readonly value?: unknown };
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (response.type === "RAW") {
      pending.resolve(response.value);
      return;
    }
    const responseWithHandler = response as typeof response & { readonly name?: unknown };
    if (
      response.type === "HANDLER" &&
      responseWithHandler.name === "proxy" &&
      response.value instanceof MessagePort
    ) {
      pending.resolve(new OfficialRemote(response.value, this.callbackPorts, this.remotePorts));
      return;
    }
    const thrown = response.value as { readonly value?: { readonly name?: string; readonly message?: string } } | undefined;
    if (thrown?.value?.name === OFFICIAL_SESSION_EXPIRED_ERROR_NAME) {
      pending.reject(new AppError(
        "SESSION_EXPIRED",
        "Official friend synchronization was unauthorized",
      ));
      return;
    }
    pending.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker call failed", {
      errorName: thrown?.value?.name ?? "UnknownError",
      safeMessage: thrown?.value?.message ?? "Worker call failed",
    }));
  }

  private failAll(error: AppError): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async apply<T>(path: readonly string[], args: readonly unknown[] = []): Promise<T> {
    if (this.closed) throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker is closed");
    await this.ready;
    const id = String(this.nextId++);
    const [argumentList, transferList] = serializeArguments(
      args,
      this.callbackPorts,
      this.remotePorts,
    );
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ id, type: "APPLY", path, argumentList }, transferList);
    });
  }

  private async applyUpdatedAuth(auth: RuntimeAuthUpdate): Promise<void> {
    this.requestAuthState = {
      httpToken: auth.httpToken,
      mcsCofSequenceIds: auth.mcsCofSequenceIds,
    };
    await this.apply(["__host", "setWebCookieHeader"], [auth.cookieHeader]);
    await this.apply(["__host", "setSsoCookieHeader"], [auth.ssoCookieHeader]);
    await this.apply(["__host", "setOfficialHttpToken"], [auth.httpToken]);
  }

  async initializeWasm(session: SessionExport): Promise<void> {
    const auth: RuntimeAuthUpdate = {
      accountId: session.accountId,
      httpToken: session.auth.httpToken,
      cookieHeader: session.auth.cookieHeader,
      ssoCookieHeader: session.auth.ssoCookieHeader ?? session.auth.cookieHeader,
      mcsCofSequenceIds: session.auth.requestHeaders["mcs-cof-ids-bin"] ?? "",
    };
    this.accountId = auth.accountId;
    await this.applyUpdatedAuth(auth);
    await this.apply(["setAuthTokenGetter"], [async () => this.requestAuthState.httpToken]);
    await this.apply(["setMcsCofSequenceIdsGetter"], [
      async () => this.requestAuthState.mcsCofSequenceIds,
    ]);
    await this.apply(["loadWasm"], [
      randomUUID(),
      async () => this.requestAuthState.httpToken,
      () => undefined,
      () => undefined,
    ]);
  }

  async updateAuth(auth: RuntimeAuthUpdate): Promise<void> {
    if (this.accountId === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging account is not initialized");
    }
    await this.applyUpdatedAuth(auth);
  }

  async createMessagingSession(args: readonly unknown[]): Promise<OfficialRemote> {
    const result = await this.apply<unknown>(["createMessagingSession"], args);
    if (!(result instanceof OfficialRemote)) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging Worker did not return a messaging session proxy");
    }
    return result;
  }

  async initializeMessagingSession(session: SessionExport): Promise<OfficialRemote> {
    const bundle = messagingArguments(
      session,
      this.options.contentDelegate,
      this.options.onMessage,
      this.options.feedDelegate,
      this.options.conversationDelegate,
    );
    const messagingSession = await this.createMessagingSession(bundle.args);
    const conversationManager = await messagingSession.callRemote(["getConversationManager"]);
    this.feedManager = await messagingSession.callRemote(["getFeedManager"]);
    this.exportMessagingStateSnapshot = bundle.exportState;
    return conversationManager;
  }

  async resolveIncomingMedia(
    mediaInfo: IncomingSnapMediaInfo,
    context: string,
  ): Promise<readonly OfficialResolvedMediaLayer[]> {
    if (this.accountId === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging account is not initialized");
    }
    return this.apply<readonly OfficialResolvedMediaLayer[]>(
      ["__host", "resolveIncomingMedia"],
      [mediaInfo, context, this.accountId],
    );
  }

  async syncFeed(reason = 0): Promise<void> {
    if (this.feedManager === undefined) {
      throw new AppError("CRYPTO_RUNTIME_FAILED", "Official messaging FeedManager is not initialized");
    }
    await this.feedManager.call<void>(["syncFeed"], [reason, undefined, new Map()]);
  }

  syncFriends(): Promise<FriendSnapshot> {
    return syncOfficialFriends(this, this.accountId);
  }

  exportMessagingState(): OfficialMessagingStateExport {
    if (this.exportMessagingStateSnapshot === undefined) {
      throw new AppError(
        "CRYPTO_RUNTIME_FAILED",
        "Official messaging session is not initialized",
      );
    }
    return this.exportMessagingStateSnapshot();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.apply(["destroyWasm"]).catch(() => undefined);
    await this.apply(["stop"]).catch(() => undefined);
    this.closed = true;
    for (const port of this.callbackPorts) port.close();
    this.callbackPorts.clear();
    for (const port of this.remotePorts) port.close();
    this.remotePorts.clear();
    this.exportMessagingStateSnapshot = undefined;
    this.feedManager = undefined;
    this.accountId = undefined;
    this.requestAuthState = { httpToken: "", mcsCofSequenceIds: "" };
    await this.worker.terminate();
  }
}
