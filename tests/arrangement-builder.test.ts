import { describe, expect, it } from "vitest";
import { layoutSections } from "../src/arrangement-builder.js";

describe("layoutSections", () => {
  it("lays sections end to end from a start bar", () => {
    const laid = layoutSections([{ name: "Intro", sceneIndex: 0, bars: 8 }, { name: "Drop", sceneIndex: 2, bars: 16 }, { name: "Outro", sceneIndex: 0, bars: 4 }], 4, 1);
    expect(laid.map(section => [section.name, section.startBeats, section.endBeats])).toEqual([["Intro", 0, 32], ["Drop", 32, 96], ["Outro", 96, 112]]);
  });

  it("uses the bar length and start bar", () => {
    expect(layoutSections([{ name: "A", sceneIndex: 0, bars: 2 }], 3.5, 5)[0]).toMatchObject({ startBeats: 14, endBeats: 21 });
  });
});
