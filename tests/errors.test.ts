import { describe, expect, it } from "vitest";
import { AppError, asAppError } from "../src/errors.js";

describe("asAppError", () => {
  it("preserves an existing typed error", () => {
    const error = new AppError("INVALID_CONFIG", "bad config", { field: "x" });
    expect(asAppError(error, "NETWORK_FAILED", "ignored")).toBe(error);
  });

  it("wraps an unknown error with the requested safe contract", () => {
    expect(asAppError(new Error("unsafe"), "NETWORK_FAILED", "request failed", { retry: false }))
      .toMatchObject({ code: "NETWORK_FAILED", message: "request failed", details: { retry: false } });
  });
});
