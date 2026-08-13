import { AppError } from "../errors.js";

export interface LoginPrompt {
  readonly readUsername: () => Promise<string>;
  readonly readPassword: () => Promise<Uint8Array>;
  readonly readOtp: () => Promise<Uint8Array>;
}

export interface LoginSessionSeed {
  readonly accountId: string;
  readonly authenticatedAt: string;
}

export type LoginStep =
  | { readonly kind: "authenticated"; readonly session: LoginSessionSeed }
  | { readonly kind: "otp-required" }
  | { readonly kind: "invalid-credentials" }
  | { readonly kind: "rate-limited"; readonly retryAfterMs?: number }
  | { readonly kind: "challenge"; readonly challenge: "captcha" | "device-approval" | "unsupported" };

export interface LoginTransport {
  readonly submitCredentials: (input: {
    readonly username: string;
    readonly password: Uint8Array;
  }) => Promise<LoginStep>;
  readonly submitOtp: (input: { readonly otp: Uint8Array }) => Promise<LoginStep>;
}

function clear(value: Uint8Array): void {
  value.fill(0);
}

function safeRetryAfter(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 86_400_000);
}

function classify(step: LoginStep): LoginStep & { readonly kind: "authenticated" } {
  if (step.kind === "authenticated") return step as LoginStep & { readonly kind: "authenticated" };
  if (step.kind === "invalid-credentials") {
    throw new AppError("LOGIN_INVALID_CREDENTIALS", "Snapchat rejected the supplied credentials");
  }
  if (step.kind === "rate-limited") {
    const retryAfterMs = safeRetryAfter(step.retryAfterMs);
    throw new AppError(
      "LOGIN_RATE_LIMITED",
      "Snapchat temporarily rate-limited login",
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
  }
  if (step.kind === "otp-required") {
    throw new AppError("LOGIN_OTP_REQUIRED", "A one-time code is required to finish login");
  }
  throw new AppError("LOGIN_CHALLENGE_REQUIRED", "Additional Snapchat verification is required", {
    challenge: step.challenge,
  });
}

export async function runLoginState(
  prompt: LoginPrompt,
  transport: LoginTransport,
  options: { readonly interactive?: boolean } = {},
): Promise<{ readonly kind: "authenticated"; readonly session: LoginSessionSeed }> {
  const username = (await prompt.readUsername()).trim();
  if (username === "") throw new AppError("LOGIN_INVALID_CREDENTIALS", "A username is required");

  const password = await prompt.readPassword();
  let first: LoginStep;
  try {
    first = await transport.submitCredentials({ username, password });
  } finally {
    clear(password);
  }
  if (first.kind !== "otp-required") return classify(first);
  if (options.interactive === false) {
    throw new AppError("LOGIN_OTP_REQUIRED", "A one-time code is required to finish login");
  }

  const otp = await prompt.readOtp();
  let second: LoginStep;
  try {
    second = await transport.submitOtp({ otp });
  } finally {
    clear(otp);
  }
  return classify(second);
}
