import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { main } from "../../src/cli/index.js";
import {
  runCliAuthRenewalProbe,
  type CliAuthRenewalDependencies,
} from "../../src/diagnostics/cli-auth-renewal.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      version: "0.1.0",
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

function session() {
  return {
    formatVersion: 1 as const,
    accountId: "11111111-2222-4333-8444-555555555555",
    buildId: "8dd50222" as const,
    exportedAt: "2026-08-12T00:00:00.000Z",
    auth: {
      httpToken: "old-http-token",
      gatewayToken: "old-gateway-token",
      cookieHeader: "web-cookie=initial-secret",
      ssoCookieHeader: "sso-cookie=initial-secret",
      ssoScuid: "11111111-2222-4333-8444-555555555555",
      requestHeaders: { "mcs-cof-ids-bin": "cof-sequence" },
    },
    assets: [],
    localStorage: {},
    indexedDb: { databases: [] },
  };
}

function config() {
  return {
    sessionFile: "private/session.json",
    assetDir: "private/assets",
    accountId: "11111111-2222-4333-8444-555555555555",
    buildId: "8dd50222" as const,
    output: "json" as const,
  };
}

function probeRequest() {
  return {
    url: "https://web.snapchat.com/com.snapchat.deltaforce.external.DeltaForce/DeltaSync",
    method: "POST",
    headers: {
      "caller-source": "WEB-ACCOUNTS",
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (windows 10; edge 151.0.0.0)",
      authorization: "Bearer request-secret",
      cookie: "cookie=request-secret",
    },
    bodyBase64: Buffer.from("probe-body-secret").toString("base64"),
  };
}

function probeFixture() {
  return {
    binding: {
      accountId: session().accountId,
      buildId: session().buildId,
      sessionExportedAt: session().exportedAt,
    },
    request: probeRequest(),
  };
}

function dependencies(
  overrides: Partial<CliAuthRenewalDependencies> = {},
): CliAuthRenewalDependencies {
  return {
    config: config(),
    session: session(),
    readProbeFixture: async () => probeFixture(),
    now: () => new Date("2026-08-12T01:02:03.000Z"),
    ...overrides,
  };
}

describe("runCliAuthRenewalProbe", () => {
  it("rejects an identity-unbound protected request before any network call", async () => {
    const fetch = vi.fn();

    await expect(runCliAuthRenewalProbe(dependencies({
      fetch,
      readProbeFixture: async () => probeRequest(),
    }))).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a protected request bound to another session epoch", async () => {
    const fetch = vi.fn();

    await expect(runCliAuthRenewalProbe(dependencies({
      fetch,
      readProbeFixture: async () => ({
        ...probeFixture(),
        binding: { ...probeFixture().binding, sessionExportedAt: "2026-08-11T00:00:00.000Z" },
      }),
    }))).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports renewed after one refresh and one read-only verification request", async () => {
    const refreshedToken = "r".repeat(96);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://accounts.snapchat.com/accounts/sso")) {
        return new Response(refreshedToken, {
          status: 200,
          headers: { scuid: session().accountId },
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${refreshedToken}`);
      expect(headers.has("cookie")).toBe(false);
      return new Response(null, { status: 200 });
    });
    const dbsc = vi.fn(async (cookieHeader: string) => ({
      cookieHeader: `${cookieHeader}; dbsc=used-secret`,
    }));
    const attestation = vi.fn(async () => "attestation-proof-secret");

    const report = await runCliAuthRenewalProbe(dependencies({ fetch, dbsc, attestation }));

    expect(report).toEqual({
      mode: "cli-only",
      result: "renewed",
      statuses: [200],
      capabilities: [
        { capability: "dbsc-profile", status: "used" },
        { capability: "web-attestation", status: "used" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toContain(refreshedToken);
    expect(JSON.stringify(report)).not.toContain("initial-secret");
    expect(JSON.stringify(report)).not.toContain("used-secret");
    expect(JSON.stringify(report)).not.toContain("attestation-proof-secret");
    expect(JSON.stringify(report)).not.toContain("probe-body-secret");
  });

  it("classifies an SSO redirect as browser-context-required and stops before verification", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      status: 303,
      headers: { location: "/v2/login?code=secret-code" },
    }));

    const report = await runCliAuthRenewalProbe(dependencies({ fetch }));

    expect(report).toEqual({
      mode: "cli-only",
      result: "browser-context-required",
      statuses: [303],
      capabilities: [{ capability: "browser-context-required", status: "rejected", httpStatus: 303 }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("secret-code");
  });

  it("classifies an unavailable DBSC profile without exposing profile or proof data", async () => {
    const dbsc = vi.fn(async () => {
      throw new AppError(
        "AUTH_CONTEXT_UNAVAILABLE",
        "DBSC profile unavailable",
        {
          reason: "dbsc-profile-unavailable",
          profileDir: "C:/Users/example/AppData/Local/Brave/profile",
          secureSessionResponse: "proof-secret",
        },
      );
    });
    const fetch = vi.fn();

    const report = await runCliAuthRenewalProbe(dependencies({ fetch, dbsc }));

    expect(report).toEqual({
      mode: "cli-only",
      result: "profile-unavailable",
      statuses: [],
      capabilities: [{ capability: "dbsc-profile", status: "unavailable" }],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("C:/Users/example/AppData/Local/Brave/profile");
    expect(JSON.stringify(report)).not.toContain("proof-secret");
  });

  it("reports rejected when verification still fails after a successful refresh", async () => {
    const refreshedToken = "t".repeat(96);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://accounts.snapchat.com/accounts/sso")) {
        return new Response(refreshedToken, {
          status: 200,
          headers: { scuid: session().accountId },
        });
      }
      return new Response(null, { status: 401 });
    });

    const report = await runCliAuthRenewalProbe(dependencies({ fetch }));

    expect(report).toEqual({
      mode: "cli-only",
      result: "rejected",
      statuses: [401],
      capabilities: [{ capability: "manual-session", status: "used" }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toContain(refreshedToken);
  });

  it("classifies a verification redirect as browser-context-required without exposing redirect data", async () => {
    const refreshedToken = "v".repeat(96);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://accounts.snapchat.com/accounts/sso")) {
        return new Response(refreshedToken, {
          status: 200,
          headers: { scuid: session().accountId },
        });
      }
      if (init?.redirect === "error") {
        throw new TypeError("redirect to /v2/login?code=secret-code");
      }
      return new Response(null, {
        status: 303,
        headers: { location: "/v2/login?code=secret-code" },
      });
    });

    const report = await runCliAuthRenewalProbe(dependencies({ fetch }));

    expect(report).toEqual({
      mode: "cli-only",
      result: "browser-context-required",
      statuses: [303],
      capabilities: [{ capability: "browser-context-required", status: "rejected", httpStatus: 303 }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toContain(refreshedToken);
    expect(JSON.stringify(report)).not.toContain("secret-code");
  });
});

describe("debug auth-renewal CLI", () => {
  it("requires SNAP_LIVE_TESTS=1", async () => {
    const output = io();

    const code = await main(["debug", "auth-renewal", "--cli-only"], output.value, { env: {} });

    expect(code).toBe(3);
    expect(output.stderr.join("\n")).toContain("INVALID_CONFIG");
  });

  it("routes debug auth-renewal --cli-only and prints the safe report", async () => {
    const output = io();
    const runDebugAuthRenewal = vi.fn(async (ioValue: { stdout: (line: string) => void }) => {
      ioValue.stdout(JSON.stringify({
        type: "debug.auth-renewal",
        mode: "cli-only",
        result: "renewed",
        statuses: [200],
        capabilities: [{ capability: "manual-session", status: "used" }],
      }));
      return 0;
    });

    const code = await main(
      ["debug", "auth-renewal", "--cli-only"],
      output.value,
      { runDebugAuthRenewal } as never,
    );

    expect(code).toBe(0);
    expect(runDebugAuthRenewal).toHaveBeenCalledOnce();
    expect(output.stdout[0]).toContain("\"debug.auth-renewal\"");
    expect(output.stdout.join("\n")).not.toContain("secret");
  });
});
