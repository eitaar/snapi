import { describe, expect, it, vi } from "vitest";
import {
  createOfficialWebSocketConstructor,
  installOfficialWebSocket,
  type OfficialWebSocketInit,
} from "../../src/runtime/official-websocket.js";

const ORIGIN = "https://www.snapchat.com";

interface SocketCall {
  readonly url: string | URL;
  readonly options: unknown;
}

class NativeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly calls: SocketCall[] = [];
  private readonly closeListeners = new Set<() => void>();
  readonly close = vi.fn(() => this.emitClose());

  constructor(readonly url: string | URL, readonly options?: unknown) {
    NativeSocket.calls.push({ url, options });
  }

  send(value: string): string {
    return `sent:${value}`;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "close") this.closeListeners.add(listener);
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

describe("official WebSocket compatibility wrapper", () => {
  it("forwards protocols and Origin while retaining native constants and instance behavior", () => {
    NativeSocket.calls.length = 0;
    const OfficialSocket = createOfficialWebSocketConstructor(NativeSocket, ORIGIN);
    const protocols = ["chat", "snap"] as const;

    const socket = new OfficialSocket("wss://example.test/socket", protocols);

    expect(NativeSocket.calls).toEqual([{
      url: "wss://example.test/socket",
      options: {
        protocols: ["chat", "snap"],
        headers: { Origin: ORIGIN },
      },
    }]);
    expect(OfficialSocket.CONNECTING).toBe(NativeSocket.CONNECTING);
    expect(OfficialSocket.OPEN).toBe(NativeSocket.OPEN);
    expect(OfficialSocket.CLOSING).toBe(NativeSocket.CLOSING);
    expect(OfficialSocket.CLOSED).toBe(NativeSocket.CLOSED);
    expect(socket).toBeInstanceOf(NativeSocket);
    expect(socket.send("payload")).toBe("sent:payload");
  });

  it("merges existing Node init headers and keeps Origin authoritative", () => {
    NativeSocket.calls.length = 0;
    const OfficialSocket = createOfficialWebSocketConstructor(NativeSocket, ORIGIN);
    const dispatcher = { name: "test-dispatcher" };
    const init: OfficialWebSocketInit = {
      protocols: "chat",
      dispatcher,
      headers: {
        "X-Trace": "opaque-value",
        origin: "https://old.example",
      },
    };

    new OfficialSocket("wss://example.test/socket", init);

    expect(NativeSocket.calls[0]).toEqual({
      url: "wss://example.test/socket",
      options: {
        protocols: "chat",
        dispatcher,
        headers: {
          "X-Trace": "opaque-value",
          Origin: ORIGIN,
        },
      },
    });
  });

  it("installs on the global and restores the previous WebSocket descriptor", () => {
    const target = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = Object.getOwnPropertyDescriptor(target, "WebSocket");
    Object.defineProperty(target, "WebSocket", {
      value: NativeSocket,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    const beforeInstall = Object.getOwnPropertyDescriptor(target, "WebSocket");

    try {
      const installed = installOfficialWebSocket(ORIGIN);

      expect(target.WebSocket).toBe(installed.WebSocket);
      expect(target.WebSocket).not.toBe(NativeSocket);

      installed.restore();
      installed.restore();
      expect(Object.getOwnPropertyDescriptor(target, "WebSocket")).toEqual(beforeInstall);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(target, "WebSocket");
      else Object.defineProperty(target, "WebSocket", previous);
    }
  });

  it("blocks disabled network access and closes sockets when capture-only mode starts", () => {
    const target = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = Object.getOwnPropertyDescriptor(target, "WebSocket");
    Object.defineProperty(target, "WebSocket", {
      value: NativeSocket,
      configurable: true,
      writable: true,
    });

    try {
      const installed = installOfficialWebSocket(ORIGIN, { allowNetwork: true });
      const socket = new installed.WebSocket("wss://example.test/socket", ["chat"]);

      installed.disableNetwork();

      expect(socket.close).toHaveBeenCalledOnce();
      expect(() => new installed.WebSocket("wss://example.test/blocked", ["chat"]))
        .toThrow("network access is disabled");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(target, "WebSocket");
      else Object.defineProperty(target, "WebSocket", previous);
    }
  });

  it("blocks construction when installed with network disabled", () => {
    const target = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = Object.getOwnPropertyDescriptor(target, "WebSocket");
    Object.defineProperty(target, "WebSocket", {
      value: NativeSocket,
      configurable: true,
      writable: true,
    });

    try {
      const installed = installOfficialWebSocket(ORIGIN, { allowNetwork: false });
      expect(() => new installed.WebSocket("wss://example.test/blocked", ["chat"]))
        .toThrow("network access is disabled");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(target, "WebSocket");
      else Object.defineProperty(target, "WebSocket", previous);
    }
  });

  it("forgets normally closed sockets and closes remaining sockets on restore", () => {
    const target = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = Object.getOwnPropertyDescriptor(target, "WebSocket");
    Object.defineProperty(target, "WebSocket", {
      value: NativeSocket,
      configurable: true,
      writable: true,
    });

    try {
      const installed = installOfficialWebSocket(ORIGIN, { allowNetwork: true });
      const closed = new installed.WebSocket(
        "wss://example.test/closed",
        ["chat"],
      ) as unknown as NativeSocket;
      const active = new installed.WebSocket(
        "wss://example.test/active",
        ["chat"],
      ) as unknown as NativeSocket;
      closed.emitClose();

      installed.restore();

      expect(closed.close).not.toHaveBeenCalled();
      expect(active.close).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(target, "WebSocket");
      else Object.defineProperty(target, "WebSocket", previous);
    }
  });
});
