import { describe, expect, it } from "vitest";
import { assertColorIndex, formatRgb, parseRgb, parseTrackColorReply } from "../src/track-color.js";

describe("track color values", () => {
  it("parses #RRGGBB and prints the 24-bit color Live stores", () => {
    expect(parseRgb("#112233")).toBe(0x112233);
    expect(parseRgb("  #00ff00")).toBe(0x00ff00);
    expect(formatRgb(0x00ff00)).toBe("#00FF00");
    expect(formatRgb(0x112233)).toBe("#112233");
    expect(() => parseRgb("112233")).toThrow(/#RRGGBB/);
    expect(() => parseRgb("#FFF")).toThrow(/#RRGGBB/);
    expect(() => parseRgb("#GG0000")).toThrow(/#RRGGBB/);
  });

  it("accepts palette indexes 0 through 69", () => {
    expect(() => assertColorIndex(0)).not.toThrow();
    expect(() => assertColorIndex(69)).not.toThrow();
    expect(() => assertColorIndex(70)).toThrow(/0 to 69/);
    expect(() => assertColorIndex(-1)).toThrow(/0 to 69/);
    expect(() => assertColorIndex(1.5)).toThrow(/0 to 69/);
  });

  it("reads a color reply and refuses a short one", () => {
    expect(parseTrackColorReply([2, 0x112233, 14])).toEqual({ index: 2, color: 0x112233, rgb: "#112233", colorIndex: 14 });
    expect(() => parseTrackColorReply([2, 0x112233])).toThrow(/truncated/);
  });
});
