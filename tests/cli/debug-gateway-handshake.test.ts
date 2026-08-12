import { describe, expect, it } from "vitest";
import { runDebugGatewayHandshake } from "../../src/cli/commands/debug-gateway-handshake.js";
import type { CliIo } from "../../src/cli/io.js";

function io(): { readonly value: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      version: "test",
    },
  };
}

describe("debug gateway-handshake", () => {
  it("requires explicit live-test opt-in before loading credentials", async () => {
    const output = io();
    await expect(runDebugGatewayHandshake([], output.value, { env: {} }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(output.stdout).toEqual([]);
  });

  it("prints only safe handshake metadata", async () => {
    const output = io();
    const session = {
      accountId: "account-1",
      buildId: "8dd50222" as const,
      auth: { gatewayToken: "gateway-secret" },
    };
    const code = await runDebugGatewayHandshake(["--json"], output.value, {
      env: {
        SNAP_LIVE_TESTS: "1",
        SNAP_BUILD_ID: "8dd50222",
        SNAP_SESSION_FILE: "private/session.json",
        SNAP_ASSET_DIR: "private/assets",
        SNAP_ACCOUNT_ID: "account-1",
      },
      loadSession: async () => session as never,
      probe: async (token) => {
        expect(token).toBe("gateway-secret");
        return {
          status: 401,
          classification: "authorization-rejected" as const,
          protocol: "none" as const,
          headerNames: ["server"],
          durationMs: 3,
        };
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      type: "debug.gateway-handshake",
      status: 401,
      classification: "authorization-rejected",
      protocol: "none",
      headerNames: ["server"],
      durationMs: 3,
    });
    expect(output.stdout.join("\n")).not.toContain("gateway-secret");
  });
});
