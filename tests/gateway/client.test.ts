import { describe, expect, it, vi } from "vitest";
import { GatewayClient, type GatewaySocket } from "../../src/gateway/client.js";
import { encodeDataFrame } from "../../src/wire/grpc-web.js";
import { encodeGatewayEnvelope } from "../../src/wire/gateway-envelope.js";
import { writeBytesField } from "../../src/wire/protobuf.js";

class FakeSocket implements GatewaySocket {
  binaryType = "blob";
  protocol = "snap-ws-auth";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn((code = 1000, reason = "") => {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  });
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown): void { this.onmessage?.({ data }); }
  closed(code: number, wasClean: boolean): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "fixture", wasClean });
  }
}

describe("GatewayClient", () => {
  it("offers auth protocols, decodes binary frames, and closes cleanly", async () => {
    const sockets: FakeSocket[] = [];
    const factory = vi.fn((_url: string, _protocols: readonly string[]) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "gateway-secret" },
      webSocketFactory: factory,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(factory).toHaveBeenCalledWith(expect.stringContaining("Gateway/WebSocketConnect"), ["snap-ws-auth", "gateway-secret"]);
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    sockets[0]!.open();
    await connecting;

    const eventPromise = client.events().next();
    const body = encodeGatewayEnvelope({ path: "mcs", messageContents: writeBytesField(1, new Uint8Array([1, 2])) });
    const framed = encodeDataFrame(body);
    sockets[0]!.message(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength));
    await expect(eventPromise).resolves.toMatchObject({ value: { type: "chat.encrypted" }, done: false });
    await client.close();
    expect(client.status()).toBe("closed");
  });

  it("reconnects after three seconds on abnormal online close", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const first = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    await first;
    sockets[0]!.closed(1006, false);
    expect(client.status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    await client.close();
    vi.useRealTimers();
  });

  it("suppresses reconnect while offline and reconnects immediately when online", async () => {
    const sockets: FakeSocket[] = [];
    let online = false;
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      isOnline: () => online,
    });
    const first = client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await first;
    sockets[0]!.closed(1006, false);
    expect(client.status()).toBe("reconnecting");
    online = true;
    client.notifyOnline();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await client.close();
  });

  it("rejects text frames without exposing their contents", async () => {
    const socket = new FakeSocket();
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => socket,
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    socket.open();
    await connecting;
    socket.message("sensitive text");
    expect(socket.close).toHaveBeenCalledWith(1003, "binary frames required");
    await client.close();
  });

  it("rejects a second connect while the first is pending", async () => {
    const socket = new FakeSocket();
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => socket,
    });
    const first = client.connect();
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    await expect(client.connect()).rejects.toMatchObject({ code: "GATEWAY_DISCONNECTED" });
    socket.open();
    await first;
    await expect(client.connect()).resolves.toBeUndefined();
    await client.close();
  });

  it("rejects an unexpected selected protocol and a pre-open socket error", async () => {
    const firstSocket = new FakeSocket();
    firstSocket.protocol = "unexpected";
    const firstClient = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => firstSocket,
    });
    const first = firstClient.connect();
    await vi.waitFor(() => expect(firstSocket.onopen).not.toBeNull());
    firstSocket.open();
    await expect(first).rejects.toMatchObject({ code: "GATEWAY_DISCONNECTED" });
    await firstClient.close();

    const secondSocket = new FakeSocket();
    const secondClient = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => secondSocket,
    });
    const second = secondClient.connect();
    await vi.waitFor(() => expect(secondSocket.onerror).not.toBeNull());
    secondSocket.onerror?.();
    await expect(second).rejects.toMatchObject({ code: "GATEWAY_DISCONNECTED" });
    await secondClient.close();
  });

  it("ends iteration after a clean peer close and ignores online notification", async () => {
    const sockets: FakeSocket[] = [];
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await connecting;
    sockets[0]!.closed(1000, true);
    expect(client.status()).toBe("closed");
    client.notifyOnline();
    expect(sockets).toHaveLength(1);
    await expect(client.events().next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("closes malformed binary frames", async () => {
    const socket = new FakeSocket();
    const client = new GatewayClient({
      auth: { getGatewayToken: async () => "token" },
      webSocketFactory: () => socket,
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    socket.open();
    await connecting;
    socket.message(new Uint8Array([1, 2]).buffer);
    expect(socket.close).toHaveBeenCalledWith(1003, "malformed binary frame");
    await client.close();
  });
});
