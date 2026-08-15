import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { finalizeWebAttestation } from "../../src/auth/web-attestation.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";

describe("finalizeWebAttestation", () => {
  it("runs the standalone attestation runtime and returns its proof", async () => {
    const run = vi.fn(async () => "proof-value");

    await expect(finalizeWebAttestation(ACCOUNT_ID, { assetDir: "assets" }, { run }))
      .resolves.toBe("proof-value");
    expect(run).toHaveBeenCalledWith(ACCOUNT_ID, { assetDir: "assets" });
  });

  it("passes the selected build to the standalone attestation runtime", async () => {
    const run = vi.fn(async (_accountId: string, options: { readonly buildId?: string }) =>
      options.buildId ?? "missing",
    );

    await expect(finalizeWebAttestation(
      ACCOUNT_ID,
      { assetDir: "assets", buildId: "da4d065e" },
      { run },
    )).resolves.toBe("da4d065e");
    expect(run).toHaveBeenCalledWith(ACCOUNT_ID, { assetDir: "assets", buildId: "da4d065e" });
  });

  it("fails closed when the runtime returns an empty proof", async () => {
    const run = vi.fn(async () => "");

    await expect(finalizeWebAttestation(ACCOUNT_ID, { assetDir: "assets" }, { run }))
      .rejects.toMatchObject({
        code: "AUTH_CONTEXT_UNAVAILABLE",
        message: "Standalone Web Attestation did not return a usable proof",
      });
  });

  it("rejects a non-UUID account identifier before starting the runtime", async () => {
    const run = vi.fn(async () => "proof-value");

    await expect(finalizeWebAttestation("not-an-account", { assetDir: "assets" }, { run }))
      .rejects.toMatchObject({ code: "INVALID_SESSION_EXPORT" });
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a runtime AppError without exposing proof material", async () => {
    const run = vi.fn(async () => {
      throw new AppError("UNSUPPORTED_BUILD", "Attestation asset is not supported", { filename: "asset.wasm" });
    });

    await expect(finalizeWebAttestation(ACCOUNT_ID, { assetDir: "assets" }, { run }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_BUILD" });
  });
});
