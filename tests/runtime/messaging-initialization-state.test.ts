import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import type { OfficialRemote } from "../../src/runtime/official-worker-client.js";
import {
  MessagingInitializationState,
  sanitizeMessagingInitializationError,
} from "../../src/runtime/messaging-initialization-state.js";

const manager = {} as OfficialRemote;

describe("MessagingInitializationState", () => {
  it("rethrows a sanitized initialization failure when a manager is required", () => {
    const state = new MessagingInitializationState();
    state.retain(new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "Official messaging Worker call failed",
      { safeMessage: "failed to create duplex client", token: "raw-transport-secret" },
    ));

    expect(() => state.require()).toThrow("Official messaging Worker call failed");
    expect(() => state.require()).toThrowError(expect.objectContaining({
      code: "CRYPTO_RUNTIME_FAILED",
      details: { safeMessage: "failed to create duplex client", token: "<REDACTED>" },
    }));
  });

  it("uses the missing-state error only when no manager or failure exists", () => {
    expect(() => new MessagingInitializationState().require()).toThrowError(expect.objectContaining({
      code: "SESSION_REEXPORT_REQUIRED",
    }));
  });

  it("clears a stale failure after successful manager initialization", () => {
    const state = new MessagingInitializationState();
    state.retain(new AppError("CRYPTO_RUNTIME_FAILED", "failed", { safeMessage: "safe" }));
    state.setManager(manager);

    expect(state.require()).toBe(manager);
  });

  it("sanitizes unknown initialization failures without retaining the raw message", () => {
    const error = sanitizeMessagingInitializationError(new Error("raw-transport-secret"));

    expect(error).toMatchObject({
      code: "CRYPTO_RUNTIME_FAILED",
      message: "Official messaging initialization failed",
      details: { errorName: "Error" },
    });
    expect(JSON.stringify(error)).not.toContain("raw-transport-secret");
  });

  it("sanitizes an unsafe AppError message while preserving safe details", () => {
    const error = sanitizeMessagingInitializationError(new AppError(
      "CRYPTO_RUNTIME_FAILED",
      "raw-transport-secret",
      { safeMessage: "failed to create duplex client" },
    ));

    expect(error.message).toBe("Official messaging initialization failed");
    expect(JSON.stringify(error)).not.toContain("raw-transport-secret");
    expect(error.details).toEqual({ safeMessage: "failed to create duplex client" });
  });
});
