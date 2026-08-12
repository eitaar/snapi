import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { classifyRenewalFailure } from "../../src/auth/renewal.js";

function expectSafeSerialization(error: AppError, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(error);
  for (const value of forbidden) {
    expect(serialized).not.toContain(value);
  }
}

describe("classifyRenewalFailure", () => {
  it("classifies a redirect as browser-context-required", () => {
    const error = new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "SSO refresh requires a browser-managed authentication context",
      {
        status: 303,
        locationOrigin: "https://accounts.snapchat.com",
        locationPath: "/v2/login",
        locationQueryKeys: ["code"],
        locationHasCode: true,
        locationHasError: false,
        leaked: "Bearer top-secret",
      },
    );

    const classified = classifyRenewalFailure(error);

    expect(classified).toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
      details: {
        status: 303,
        observations: [{ capability: "browser-context-required", status: "rejected", httpStatus: 303 }],
      },
    });
    expectSafeSerialization(classified, ["Bearer", "top-secret"]);
  });

  it("classifies a missing DBSC profile as unavailable without preserving unsafe details", () => {
    const error = new AppError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "wording may change without changing the structured reason",
      {
        reason: "dbsc-profile-unavailable",
        profileDir: "C:/Users/example/AppData/Local/Brave/profile",
        secureSessionResponse: "proof-secret",
      },
    );

    const classified = classifyRenewalFailure(error);

    expect(classified).toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
      details: {
        observations: [{ capability: "dbsc-profile", status: "unavailable" }],
      },
    });
    expectSafeSerialization(classified, [
      "C:/Users/example/AppData/Local/Brave/profile",
      "secureSessionResponse",
      "proof-secret",
    ]);
  });

  it("classifies an SSO 403 as browser-context-required", () => {
    const error = new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Exported Snapchat cookies can no longer refresh authentication",
      {
        status: 403,
        cookieHeader: "sc-a-session=secret",
      },
    );

    const classified = classifyRenewalFailure(error);

    expect(classified).toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
      details: {
        status: 403,
        observations: [{ capability: "browser-context-required", status: "rejected", httpStatus: 403 }],
      },
    });
    expectSafeSerialization(classified, ["sc-a-session", "secret"]);
  });

  it("classifies a malformed token response as rejected without echoing the token", () => {
    const error = new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "SSO refresh returned an invalid token",
      {
        reason: "invalid-token",
        responseBody: "x".repeat(96),
      },
    );

    const classified = classifyRenewalFailure(error);

    expect(classified).toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      details: {
        observations: [{ capability: "manual-session", status: "rejected" }],
      },
    });
    expectSafeSerialization(classified, ["xxxxxxxx", "responseBody"]);
  });

  it("does not use error wording to choose a renewal capability", () => {
    const first = classifyRenewalFailure(new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "invalid token wording",
    ));
    const second = classifyRenewalFailure(new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "unrelated wording",
    ));

    expect(first.details.observations).toEqual(second.details.observations);
  });

  it("wraps an unknown failure in a safe renewal contract", () => {
    const classified = classifyRenewalFailure(new Error("cookie=secret-token"));

    expect(classified).toMatchObject({
      code: "SESSION_REEXPORT_REQUIRED",
      message: "CLI-only authentication renewal failed",
      details: {
        observations: [{ capability: "manual-session", status: "rejected" }],
      },
    });
    expectSafeSerialization(classified, ["cookie=secret-token", "secret-token"]);
  });
});
