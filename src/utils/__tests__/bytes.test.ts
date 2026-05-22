import { describe, expect, it } from "vitest";
import { formatBytes } from "../bytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1048576, "1.0 MB"],
    [1073741824, "1.0 GB"],
    [1099511627776, "1.0 TB"],
  ])("formatBytes(%i) === %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("throws RangeError for negative input", () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
  });
});
