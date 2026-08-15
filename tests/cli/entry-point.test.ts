import { describe, expect, test } from "vitest";
import { isCliEntryPoint } from "../../src/cli/entry-point.js";

describe("CLI entry-point detection", () => {
  test("recognizes a linked executable path by its resolved module path", () => {
    const resolvedPaths: Record<string, string> = {
      "C:\\Users\\global\\npm\\node_modules\\snap-private-cli\\dist\\cli\\index.js":
        "C:\\repo\\dist\\cli\\index.js",
      "C:\\repo\\dist\\cli\\index.js": "C:\\repo\\dist\\cli\\index.js",
    };
    const resolvePath = (path: string): string => resolvedPaths[path] ?? path;

    expect(isCliEntryPoint(
      "C:\\Users\\global\\npm\\node_modules\\snap-private-cli\\dist\\cli\\index.js",
      "file:///C:/repo/dist/cli/index.js",
      resolvePath,
    )).toBe(true);
  });
});
