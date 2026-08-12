import { describe, expect, it } from "vitest";
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

  constructor(readonly url: string | URL, readonly options?: unknown) {
    NativeSocket.calls.push({ url, options });
  }

  send(value: string): string {
    return `sent:${value}`;
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
});
