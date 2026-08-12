export interface OfficialWebSocketInit {
  readonly protocols?: string | readonly string[];
  readonly dispatcher?: unknown;
  readonly headers?: HeadersInit;
}

export type OfficialWebSocketProtocols = string | readonly string[] | OfficialWebSocketInit;

export interface OfficialWebSocketConstructor<TInstance extends object = WebSocket> {
  readonly prototype: TInstance;
  new (url: string | URL, protocols?: OfficialWebSocketProtocols): TInstance;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
}

interface NativeWebSocketConstructor<TInstance extends object> {
  readonly prototype: TInstance;
  new (url: string | URL, options?: unknown): TInstance;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
}

interface ClosableWebSocket {
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: string,
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
}

interface OfficialWebSocketPolicy<TInstance extends object> {
  readonly isNetworkAllowed?: () => boolean;
  readonly onConstructed?: (socket: TInstance) => void;
}

interface NodeWebSocketInit {
  readonly protocols?: string | string[] | undefined;
  readonly dispatcher?: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

function copyProtocols(protocols: string | readonly string[] | undefined): string | string[] | undefined {
  return protocols === undefined || typeof protocols === "string" ? protocols : [...protocols];
}

function copyHeaderEntries(
  target: Record<string, string>,
  headers: HeadersInit | undefined,
): void {
  if (headers === undefined) return;
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) target[name] = value;
    return;
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, name) => {
      target[name] = value;
    });
    return;
  }
  for (const [name, value] of Object.entries(headers)) target[name] = value;
}

function mergeHeaders(existing: HeadersInit | undefined, origin: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  copyHeaderEntries(headers, existing);
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "origin") delete headers[name];
  }
  headers.Origin = origin;
  return headers;
}

function isInit(value: OfficialWebSocketProtocols | undefined): value is OfficialWebSocketInit {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function createNodeInit(
  protocolsOrInit: OfficialWebSocketProtocols | undefined,
  origin: string,
): NodeWebSocketInit {
  if (isInit(protocolsOrInit)) {
    const { protocols, headers, ...rest } = protocolsOrInit;
    return {
      ...rest,
      ...(protocols === undefined ? {} : { protocols: copyProtocols(protocols) }),
      headers: mergeHeaders(headers, origin),
    };
  }
  return {
    ...(protocolsOrInit === undefined ? {} : { protocols: copyProtocols(protocolsOrInit) }),
    headers: mergeHeaders(undefined, origin),
  };
}

export function createOfficialWebSocketConstructor<TInstance extends object>(
  native: NativeWebSocketConstructor<TInstance>,
  origin: string,
  policy: OfficialWebSocketPolicy<TInstance> = {},
): OfficialWebSocketConstructor<TInstance> {
  const OfficialWebSocket = function (
    this: TInstance,
    url: string | URL,
    protocolsOrInit?: OfficialWebSocketProtocols,
  ): TInstance {
    if (new.target === undefined) {
      throw new TypeError("WebSocket constructor must be called with new");
    }
    if (policy.isNetworkAllowed?.() === false) {
      throw new Error("Official WebSocket network access is disabled");
    }
    const socket = Reflect.construct(
      native,
      [url, createNodeInit(protocolsOrInit, origin)],
    ) as TInstance;
    policy.onConstructed?.(socket);
    return socket;
  };
  Object.setPrototypeOf(OfficialWebSocket, native);
  Object.defineProperty(OfficialWebSocket, "prototype", {
    value: native.prototype,
  });
  return OfficialWebSocket as unknown as OfficialWebSocketConstructor<TInstance>;
}

export interface InstalledOfficialWebSocket {
  readonly WebSocket: OfficialWebSocketConstructor;
  readonly disableNetwork: () => void;
  readonly restore: () => void;
}

export function installOfficialWebSocket(
  origin: string,
  options: { readonly allowNetwork?: boolean } = {},
): InstalledOfficialWebSocket {
  const target = globalThis as unknown as Record<PropertyKey, unknown>;
  const native = target.WebSocket;
  if (typeof native !== "function") throw new Error("Node WebSocket is unavailable");

  const previous = Object.getOwnPropertyDescriptor(target, "WebSocket");
  let networkAllowed = options.allowNetwork ?? true;
  const active = new Set<ClosableWebSocket>();
  const installed = createOfficialWebSocketConstructor(
    native as unknown as NativeWebSocketConstructor<WebSocket>,
    origin,
    {
      isNetworkAllowed: () => networkAllowed,
      onConstructed: (socket) => {
        active.add(socket);
        socket.addEventListener?.("close", () => active.delete(socket), { once: true });
      },
    },
  );
  Object.defineProperty(target, "WebSocket", {
    value: installed,
    configurable: true,
    enumerable: previous?.enumerable ?? true,
    writable: true,
  });

  const disableNetwork = (): void => {
    networkAllowed = false;
    for (const socket of active) {
      try {
        socket.close(1000, "network disabled");
      } catch {
        // The network boundary remains disabled even if a native socket is already broken.
      }
    }
    active.clear();
  };
  let restored = false;
  return {
    WebSocket: installed,
    disableNetwork,
    restore: () => {
      if (restored) return;
      restored = true;
      disableNetwork();
      if (previous === undefined) Reflect.deleteProperty(target, "WebSocket");
      else Object.defineProperty(target, "WebSocket", previous);
    },
  };
}
