import { describe, expect, it } from "vitest";
import {
  isOfficialAuthFailure,
  officialSessionExpiredError,
  OFFICIAL_SESSION_EXPIRED_ERROR_NAME,
} from "../../src/runtime/official-auth-failure.js";

describe("official Friends auth failure classification", () => {
  it("uses only safe numeric HTTP or gRPC status metadata", () => {
    expect(isOfficialAuthFailure(new Error("raw transport secret"), [{
      path: "https://web.snapchat.com/com.snapchat.atlas.gw.AtlasGw/SyncFriendData",
      method: "POST",
      responseStatus: 401,
    }])).toBe(true);
    expect(isOfficialAuthFailure({ grpcStatus: 16 }, [])).toBe(true);
    expect(isOfficialAuthFailure(new Error("HTTP 401 raw transport secret"), [])).toBe(false);
  });

  it("creates only the stable sanitized worker-boundary marker", () => {
    const error = officialSessionExpiredError();
    expect(error).toMatchObject({
      name: OFFICIAL_SESSION_EXPIRED_ERROR_NAME,
      message: "Official friend synchronization was unauthorized",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
