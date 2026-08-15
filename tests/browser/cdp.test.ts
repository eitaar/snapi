import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBrowserState } from "../../src/browser/cdp.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(value: string): void {
    const message = JSON.parse(value) as { id: number; method: string };
    if (message.method !== "Runtime.evaluate") return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        id: message.id,
        result: {
          result: {
            value: {
              pageUrl: "https://web.snapchat.com/",
              localStorage: { a: "b" },
              sessionStorage: { e2eeTempKey: "opaque" },
              indexedDb: { databases: [] },
            },
          },
        },
      }),
    })));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

describe("captureBrowserState", () => {
  it("reads only the selected logged-in page through local CDP", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      type: "page",
      url: "https://web.snapchat.com/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
    }]), { status: 200 }));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    await expect(captureBrowserState({
      cdpUrl: "http://127.0.0.1:9222",
      targetUrl: "https://web.snapchat.com/",
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      pageUrl: "https://web.snapchat.com/",
      localStorage: { a: "b" },
      sessionStorage: { e2eeTempKey: "opaque" },
    });
  });

  it("rejects remote CDP endpoints before reading browser state", async () => {
    await expect(captureBrowserState({
      cdpUrl: "http://192.0.2.10:9222",
      targetUrl: "https://web.snapchat.com/",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
