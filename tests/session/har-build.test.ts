import { describe, expect, it } from "vitest";
import { detectHarBuildId } from "../../src/session/har-build.js";

function har(versionMarkers: readonly string[]): unknown {
  return {
    log: {
      entries: versionMarkers.map((version) => ({
        request: {
          method: "GET",
          url: `https://www.snapchat.com/web/version.json?version=${version}`,
        },
        response: { status: 200 },
      })),
    },
  };
}

describe("detectHarBuildId", () => {
  it.each(["8dd50222", "da4d065e"])("detects supported build %s", (version) => {
    expect(detectHarBuildId(har([version]))).toBe(version);
  });

  it("rejects an unknown build marker", () => {
    expect(detectHarBuildId(har(["future-build"]))).toBeUndefined();
  });

  it("rejects a HAR that mixes build markers", () => {
    expect(detectHarBuildId(har(["8dd50222", "da4d065e"]))).toBeUndefined();
  });

  it("rejects a HAR without a build marker", () => {
    expect(detectHarBuildId({ log: { entries: [] } })).toBeUndefined();
  });
});
