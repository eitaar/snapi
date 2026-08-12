import { AppError } from "../errors.js";
import { decodeGrpcWebFrames } from "../wire/grpc-web.js";
import { decodeGatewayEnvelope } from "../wire/gateway-envelope.js";
import { classifyGatewayEnvelope } from "./classifier.js";
import type { GatewayEvent, GatewayStatus } from "./events.js";

const DEFAULT_GATEWAY_URL = "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";
const GATEWAY_ORIGIN = "https://www.snapchat.com";

type WebSocketInit = {
  readonly protocols?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | readonly string[] | WebSocketInit,
) => WebSocket;

export interface GatewaySocket {
  binaryType: string;
  readonly protocol: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string; readonly wasClean: boolean }) => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols: readonly string[],
  headers?: Readonly<Record<string, string>>,
) => GatewaySocket;

export interface GatewayAuthSource {
  getGatewayToken(): Promise<string>;
  getGatewayCookie?(): Promise<string>;
}

export interface GatewayClientOptions {
  readonly auth: GatewayAuthSource;
  readonly webSocketFactory?: WebSocketFactory;
  readonly url?: string;
  readonly isOnline?: () => boolean;
  readonly now?: () => Date;
  readonly reconnectDelayMs?: number;
}

interface EventWaiter {
  readonly resolve: (result: IteratorResult<GatewayEvent>) => void;
}

export class GatewayClient {
  private readonly factory: WebSocketFactory;
  private readonly url: string;
  private readonly reconnectDelayMs: number;
  private socket: GatewaySocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private currentStatus: GatewayStatus = "idle";
  private desiredOpen = false;
  private readonly queuedEvents: GatewayEvent[] = [];
  private readonly waiters: EventWaiter[] = [];

  constructor(private readonly options: GatewayClientOptions) {
    this.factory = options.webSocketFactory ?? ((url, protocols, headers) => {
      const Socket = WebSocket as unknown as WebSocketConstructor;
      const init: WebSocketInit = {
        protocols: [...protocols],
        ...(headers === undefined ? {} : { headers }),
      };
      return new Socket(url, headers === undefined ? [...protocols] : init) as unknown as GatewaySocket;
    });
    this.url = options.url ?? DEFAULT_GATEWAY_URL;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3_000;
  }

  status(): GatewayStatus {
    return this.currentStatus;
  }

  private emit(event: GatewayEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ value: event, done: false });
    else this.queuedEvents.push(event);
  }

  events(): AsyncIterableIterator<GatewayEvent> {
    return {
      [Symbol.asyncIterator]() { return this; },
      next: async (): Promise<IteratorResult<GatewayEvent>> => {
        const event = this.queuedEvents.shift();
        if (event !== undefined) return { value: event, done: false };
        if (!this.desiredOpen && this.currentStatus === "closed") return { value: undefined, done: true };
        return new Promise<IteratorResult<GatewayEvent>>((resolve) => this.waiters.push({ resolve }));
      },
    };
  }

  async connect(): Promise<void> {
    if (this.currentStatus === "open") return;
    if (this.currentStatus === "connecting") {
      throw new AppError("GATEWAY_DISCONNECTED", "Gateway connection is already in progress");
    }
    this.desiredOpen = true;
    return this.openSocket(false);
  }

  private async openSocket(reconnecting: boolean): Promise<void> {
    if (!this.desiredOpen) return;
    this.currentStatus = reconnecting ? "reconnecting" : "connecting";
    const token = await this.options.auth.getGatewayToken();
    if (!this.desiredOpen) return;
    const cookie = this.options.auth.getGatewayCookie === undefined
      ? undefined
      : await this.options.auth.getGatewayCookie();
    const headers = cookie === undefined
      ? undefined
      : { cookie, origin: GATEWAY_ORIGIN };
    const socket = headers === undefined
      ? this.factory(this.url, ["snap-ws-auth", token])
      : this.factory(this.url, ["snap-ws-auth", token], headers);
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.onopen = () => {
        if (socket !== this.socket || !this.desiredOpen) return;
        if (socket.protocol !== "snap-ws-auth") {
          socket.close(1002, "unexpected subprotocol");
          if (!settled) {
            settled = true;
            reject(new AppError("GATEWAY_DISCONNECTED", "Gateway selected an unexpected subprotocol"));
          }
          return;
        }
        this.currentStatus = "open";
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      socket.onmessage = (event) => this.handleMessage(socket, event.data);
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new AppError("GATEWAY_DISCONNECTED", "Gateway connection failed"));
        }
      };
      socket.onclose = (event) => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        if (!settled) {
          settled = true;
          reject(new AppError("GATEWAY_DISCONNECTED", "Gateway closed before becoming ready", {
            code: event.code,
          }));
        }
        if (!this.desiredOpen) {
          this.currentStatus = "closed";
          return;
        }
        if (event.wasClean && event.code !== 1006) {
          this.desiredOpen = false;
          this.currentStatus = "closed";
          this.finishEvents();
          return;
        }
        this.scheduleReconnect();
      };
    });
  }

  private handleMessage(socket: GatewaySocket, data: unknown): void {
    if (socket !== this.socket) return;
    if (!(data instanceof ArrayBuffer)) {
      socket.close(1003, "binary frames required");
      return;
    }
    try {
      for (const frame of decodeGrpcWebFrames(new Uint8Array(data))) {
        if (frame.kind !== "data") continue;
        const event = classifyGatewayEnvelope(
          decodeGatewayEnvelope(frame.payload),
          (this.options.now ?? (() => new Date()))().toISOString(),
        );
        if (event !== undefined) this.emit(event);
      }
    } catch {
      socket.close(1003, "malformed binary frame");
    }
  }

  private scheduleReconnect(): void {
    this.currentStatus = "reconnecting";
    if (!this.desiredOpen || !(this.options.isOnline ?? (() => true))()) return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket(true).catch(() => {
        if (this.desiredOpen) this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  notifyOnline(): void {
    if (!this.desiredOpen || this.socket !== undefined || this.currentStatus !== "reconnecting") return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    void this.openSocket(true).catch(() => {
      if (this.desiredOpen) this.scheduleReconnect();
    });
  }

  private finishEvents(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  async close(): Promise<void> {
    this.desiredOpen = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.currentStatus = "closed";
    this.finishEvents();
    if (socket !== undefined && socket.readyState < 2) socket.close(1000, "client shutdown");
  }
}
