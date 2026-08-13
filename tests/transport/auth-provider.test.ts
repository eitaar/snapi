import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/transport/auth-provider.js";
import type { SessionExport } from "../../src/session/types.js";
import { AppError } from "../../src/errors.js";

function session(exportedAt = "2026-08-11T00:30:00.000Z"): SessionExport {
  return {
    formatVersion: 1,
    accountId: "account",
    buildId: "8dd50222",
    exportedAt,
    auth: {
      httpToken: "http-old",
      gatewayToken: "gateway-old",
      cookieHeader: "cookie=old",
      requestHeaders: { "mcs-cof-ids-bin": "cof" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

describe("AuthProvider", () => {
  it("returns current request authentication when the export is fresh", async () => {
    const refresh = vi.fn(async (value: SessionExport) => value);
    const provider = new AuthProvider(session("2026-08-11T00:55:00.000Z"), {
      refresh,
      now: () => Date.parse("2026-08-11T01:00:00.000Z"),
    });

    await expect(provider.getRequestAuth()).resolves.toEqual({
      httpToken: "http-old",
      cookieHeader: "cookie=old",
      headers: { "mcs-cof-ids-bin": "cof" },
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns the matching gateway token after applying the freshness policy", async () => {
    const provider = new AuthProvider(session(), {
      refresh: async (value) => ({
        ...value,
        exportedAt: "2026-08-11T02:00:00.000Z",
        auth: { ...value.auth, gatewayToken: "gateway-new" },
      }),
      now: () => Date.parse("2026-08-11T02:00:00.000Z"),
    });

    await expect(provider.getGatewayToken()).resolves.toBe("gateway-new");
  });

  it("refreshes a token older than ten minutes and persists before publishing it", async () => {
    const refreshed = {
      ...session(),
      exportedAt: "2026-08-11T02:00:00.000Z",
      auth: { ...session().auth, httpToken: "http-new", cookieHeader: "cookie=new" },
    };
    const events: string[] = [];
    const provider = new AuthProvider(session("2026-08-10T23:00:00.000Z"), {
      refresh: async () => { events.push("refresh"); return refreshed; },
      persist: async () => { events.push("persist"); },
      now: () => Date.parse("2026-08-11T02:00:00.000Z"),
    });

    await expect(provider.getRequestAuth()).resolves.toMatchObject({ httpToken: "http-new" });
    expect(events).toEqual(["refresh", "persist"]);
    expect(provider.sessionSnapshot()).toBe(refreshed);
  });

  it("shares one refresh across concurrent 401 and gRPC 16 callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = vi.fn(async () => {
      await gate;
      return { ...session(), auth: { ...session().auth, httpToken: "new" } };
    });
    const provider = new AuthProvider(session(), { refresh });

    const first = provider.refreshOnce({ kind: "http", status: 401 });
    const second = provider.refreshOnce({ kind: "grpc", status: 16 });
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the old session when refresh persistence fails", async () => {
    const original = session();
    const provider = new AuthProvider(original, {
      refresh: async () => ({ ...original, auth: { ...original.auth, httpToken: "secret-new" } }),
      persist: async () => { throw new Error("disk unavailable"); },
    });

    await expect(provider.refreshOnce({ kind: "http", status: 403 })).rejects.toThrow("disk unavailable");
    expect(provider.sessionSnapshot()).toBe(original);
  });

  it("keeps the old session when refresh itself fails", async () => {
    const original = session();
    const provider = new AuthProvider(original, {
      refresh: async () => { throw new Error("refresh denied"); },
    });

    await expect(provider.refreshOnce({ kind: "http", status: 401 })).rejects.toThrow("refresh denied");
    expect(provider.sessionSnapshot()).toBe(original);
  });

  it("classifies browser-context renewal failures as login-required", async () => {
    const provider = new AuthProvider(session(), {
      refresh: async () => {
        throw new AppError("AUTH_CONTEXT_UNAVAILABLE", "browser context required", { status: 303 });
      },
    });

    await expect(provider.refreshOnce({ kind: "http", status: 401 })).rejects.toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
    });
    expect(provider.renewalStatus()).toEqual({
      state: "login-required",
      consecutiveFailures: 1,
      lastFailure: "browser-context-required",
    });
  });

  it("backs off transient automatic renewal failures and recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T01:00:00.000Z");
    const refreshed = session("2026-08-11T01:00:02.000Z");
    let attempts = 0;
    const refresh = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      return refreshed;
    });
    const errors: unknown[] = [];
    const provider = new AuthProvider(session("2026-08-11T00:59:59.000Z"), {
      refresh,
      maxAgeMs: 2_000,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      random: () => 1,
    });

    const stop = provider.startAutoRefresh((error) => errors.push(error));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(provider.renewalStatus()).toMatchObject({ state: "backoff", consecutiveFailures: 1 });

    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(provider.renewalStatus()).toEqual({ state: "ready", consecutiveFailures: 0 });

    stop();
    vi.useRealTimers();
  });

  it("automatically refreshes and publishes shared auth while a client stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T01:00:00.000Z");
    const original = session("2026-08-11T00:55:00.000Z");
    const refreshed: SessionExport = {
      ...original,
      exportedAt: "2026-08-11T01:05:00.000Z",
      auth: {
        ...original.auth,
        httpToken: "shared-new",
        gatewayToken: "shared-new",
        tokenRefreshedAt: "2026-08-11T01:05:00.000Z",
      },
    };
    const refresh = vi.fn(async () => refreshed);
    const persist = vi.fn(async () => undefined);
    const provider = new AuthProvider(original, { refresh, persist });

    const stop = provider.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(refreshed);
    await expect(provider.getGatewayToken()).resolves.toBe("shared-new");

    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("caps auto-refresh scheduling when a captured timestamp is in the future", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T01:00:00.000Z");
    const refresh = vi.fn(async (value: SessionExport) => value);
    const provider = new AuthProvider(session("2099-08-11T01:00:00.000Z"), { refresh });

    const stop = provider.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).not.toHaveBeenCalled();

    stop();
    vi.useRealTimers();
  });
});
