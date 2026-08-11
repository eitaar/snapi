import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/transport/auth-provider.js";
import type { SessionExport } from "../../src/session/types.js";

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
    const provider = new AuthProvider(session(), {
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

  it("refreshes a session older than one hour and persists before publishing it", async () => {
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
});
