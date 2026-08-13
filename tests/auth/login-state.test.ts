import { describe, expect, it, vi } from "vitest";
import { runLoginState, type LoginPrompt, type LoginTransport } from "../../src/auth/login-state.js";
import { AppError } from "../../src/errors.js";

function prompt(values: { readonly password?: string; readonly otp?: string }): LoginPrompt {
  return {
    readUsername: vi.fn(async () => "user@example.test"),
    readPassword: vi.fn(async () => new Uint8Array(Buffer.from(values.password ?? "password"))),
    readOtp: vi.fn(async () => new Uint8Array(Buffer.from(values.otp ?? "123456"))),
  };
}

function authenticated() {
  return { kind: "authenticated" as const, session: { accountId: "account-1", authenticatedAt: "now" } };
}

describe("runLoginState", () => {
  it("submits credentials once and returns an authenticated seed", async () => {
    const loginPrompt = prompt({});
    let capturedPassword = new Uint8Array();
    const submitCredentials = vi.fn(async (input: { readonly username: string; readonly password: Uint8Array }) => {
      capturedPassword = Uint8Array.from(input.password);
      return authenticated();
    });
    const transport: LoginTransport = { submitCredentials, submitOtp: vi.fn() };

    await expect(runLoginState(loginPrompt, transport)).resolves.toEqual(authenticated());
    expect(submitCredentials).toHaveBeenCalledOnce();
    expect(transport.submitOtp).not.toHaveBeenCalled();
    const submitted = submitCredentials.mock.calls[0]![0];
    expect(submitted.username).toBe("user@example.test");
    expect(capturedPassword).toEqual(new Uint8Array(Buffer.from("password")));
    expect(submitted.password).toEqual(new Uint8Array(submitted.password.length));
  });

  it("asks for OTP exactly once after an OTP transition and clears both buffers", async () => {
    const firstPassword = new Uint8Array(Buffer.from("secret"));
    const loginPrompt = {
      ...prompt({ password: "secret", otp: "654321" }),
      readPassword: vi.fn(async () => firstPassword),
    };
    const submitCredentials = vi.fn(async () => ({ kind: "otp-required" as const }));
    const submitOtp = vi.fn(async () => authenticated());

    await expect(runLoginState(loginPrompt, { submitCredentials, submitOtp })).resolves.toEqual(authenticated());
    expect(loginPrompt.readOtp).toHaveBeenCalledOnce();
    expect(submitOtp).toHaveBeenCalledOnce();
    expect(firstPassword).toEqual(new Uint8Array(firstPassword.length));
  });

  it.each([
    ["invalid-credentials", "LOGIN_INVALID_CREDENTIALS"],
    ["captcha", "LOGIN_CHALLENGE_REQUIRED"],
    ["device-approval", "LOGIN_CHALLENGE_REQUIRED"],
    ["unsupported", "LOGIN_CHALLENGE_REQUIRED"],
  ] as const)("stops safely on %s", async (kind, code) => {
    const transport: LoginTransport = {
      submitCredentials: vi.fn(async () => kind === "invalid-credentials"
        ? { kind }
        : { kind: "challenge" as const, challenge: kind }),
      submitOtp: vi.fn(),
    };

    await expect(runLoginState(prompt({}), transport)).rejects.toMatchObject({ code });
    expect(transport.submitOtp).not.toHaveBeenCalled();
  });

  it("returns safe rate-limit metadata and does not retry", async () => {
    const transport: LoginTransport = {
      submitCredentials: vi.fn(async () => ({ kind: "rate-limited" as const, retryAfterMs: 12_000 })),
      submitOtp: vi.fn(),
    };

    await expect(runLoginState(prompt({}), transport)).rejects.toMatchObject({
      code: "LOGIN_RATE_LIMITED",
      details: { retryAfterMs: 12_000 },
    });
    expect(transport.submitCredentials).toHaveBeenCalledOnce();
  });

  it("does not ask for OTP in non-interactive mode", async () => {
    const loginPrompt = prompt({});
    const transport: LoginTransport = {
      submitCredentials: vi.fn(async () => ({ kind: "otp-required" as const })),
      submitOtp: vi.fn(),
    };

    await expect(runLoginState(loginPrompt, transport, { interactive: false })).rejects.toMatchObject({
      code: "LOGIN_OTP_REQUIRED",
    });
    expect(loginPrompt.readOtp).not.toHaveBeenCalled();
  });
});
