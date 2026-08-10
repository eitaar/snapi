import { describe, expect, it } from "vitest";
import { installBrowserGlobals } from "../../src/runtime/browser-globals.js";

describe("installBrowserGlobals", () => {
  it("installs the deliberate browser surface on one target and restores it", () => {
    const target: Record<PropertyKey, unknown> = { existing: true };
    const installed = installBrowserGlobals(
      {
        origin: "https://www.snapchat.com",
        userAgent: "Snap Runtime Test",
        localStorage: { device: "stored" },
      },
      target,
    );

    expect(target.self).toBe(target);
    expect(target.window).toBe(target);
    expect(target.crypto).toBeDefined();
    expect((target.crypto as Crypto).subtle).toBeDefined();
    expect(target.TextEncoder).toBe(TextEncoder);
    expect(target.TextDecoder).toBe(TextDecoder);
    expect(target.performance).toBeDefined();
    expect(target.fetch).toBe(fetch);
    expect(target.WebSocket).toBe(WebSocket);
    expect((target.atob as (value: string) => string)("YQ==")).toBe("a");
    expect((target.btoa as (value: string) => string)("a")).toBe("YQ==");
    expect((target.localStorage as Storage).getItem("device")).toBe("stored");
    expect((target.navigator as { userAgent: string }).userAgent).toBe("Snap Runtime Test");
    expect((target.location as { origin: string }).origin).toBe("https://www.snapchat.com");
    expect(target.indexedDB).toBe(installed.indexedDB);
    expect(target.IDBKeyRange).toBeDefined();

    installed.restore();
    expect(target).toEqual({ existing: true });
  });

  it("restores overwritten descriptors exactly and is idempotent", () => {
    const target: Record<PropertyKey, unknown> = {};
    Object.defineProperty(target, "window", { value: "original", enumerable: false, configurable: true });
    const before = Object.getOwnPropertyDescriptor(target, "window");
    const installed = installBrowserGlobals(
      { origin: "https://www.snapchat.com", userAgent: "UA", localStorage: {} },
      target,
    );

    installed.restore();
    installed.restore();
    expect(Object.getOwnPropertyDescriptor(target, "window")).toEqual(before);
  });
});
