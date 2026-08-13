import { describe, expect, it, vi } from "vitest";
import { runSessionLogin } from "../../src/cli/commands/session-login.js";
import type { AppConfig } from "../../src/config.js";
import type { SessionExport } from "../../src/session/types.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, value: { version: "0.1.0", stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

const config: AppConfig = {
  sessionFile: "private/session.json",
  assetDir: "private/assets",
  accountId: "account-1",
  buildId: "8dd50222",
  output: "json",
};

const session: SessionExport = {
  formatVersion: 1,
  accountId: "account-1",
  buildId: "8dd50222",
  exportedAt: "2026-08-13T00:00:00.000Z",
  auth: { httpToken: "http", gatewayToken: "gateway", cookieHeader: "cookie", requestHeaders: {} },
  assets: [],
  localStorage: {},
  indexedDb: { databases: [] },
};

describe("session login command", () => {
  it("persists only after the injected authenticated session is finalized", async () => {
    const output = io();
    const persistSession = vi.fn(async () => undefined);
    const code = await runSessionLogin([], output.value, {
      config,
      output: "json",
      prompt: {
        readUsername: vi.fn(async () => "user@example.test"),
        readPassword: vi.fn(async () => new Uint8Array([1, 2, 3])),
        readOtp: vi.fn(async () => new Uint8Array([4, 5, 6])),
      },
      transport: {
        submitCredentials: vi.fn(async () => ({ kind: "authenticated" as const, session: { accountId: "account-1", authenticatedAt: "now" } })),
        submitOtp: vi.fn(),
      },
      finalizeSession: vi.fn(async () => session),
      persistSession,
    });

    expect(code).toBe(0);
    expect(persistSession).toHaveBeenCalledWith(session, config.sessionFile);
    expect(output.stdout[0]).toBe(JSON.stringify({ type: "session.logged-in", buildId: "8dd50222" }));
    expect(output.stdout.join("\n")).not.toContain("user@example.test");
    expect(output.stdout.join("\n")).not.toContain("http");
  });
});
