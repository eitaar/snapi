import { describe, expect, it, vi } from "vitest";
import { createProcessIo } from "../../src/cli/io.js";

describe("process CLI IO", () => {
  it("writes complete lines to the matching process streams", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const io = createProcessIo("1.2.3");
    expect(io.version).toBe("1.2.3");
    io.stdout("out");
    io.stderr("err");
    expect(stdout).toHaveBeenCalledWith("out\n");
    expect(stderr).toHaveBeenCalledWith("err\n");
  });
});
