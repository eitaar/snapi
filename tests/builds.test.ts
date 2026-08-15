import { describe, expect, it } from "vitest";
import { isSupportedBuildId, SUPPORTED_BUILD_IDS } from "../src/builds.js";

describe("supported Snapchat Web builds", () => {
  it("includes the existing and newly observed builds", () => {
    expect(SUPPORTED_BUILD_IDS).toEqual(["8dd50222", "da4d065e"]);
    expect(isSupportedBuildId("8dd50222")).toBe(true);
    expect(isSupportedBuildId("da4d065e")).toBe(true);
  });

  it("rejects arbitrary build identifiers", () => {
    expect(isSupportedBuildId("future-build")).toBe(false);
    expect(isSupportedBuildId(undefined)).toBe(false);
  });
});
