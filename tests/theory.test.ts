import { describe, expect, it } from "vitest";
import { chordNotes, drumNotes, mapDrumPads, parseNumeral, scaleSteps, voiceLead } from "../src/theory.js";

const pcs = (chord: { root: number; intervals: number[] }) => chord.intervals.map(step => (chord.root + step) % 12);
const major = scaleSteps("major"), minor = scaleSteps("minor");

describe("Roman numerals", () => {
  it("builds diatonic chords in C major", () => {
    expect(pcs(parseNumeral("I", 0, major))).toEqual([0, 4, 7]);
    expect(pcs(parseNumeral("vi", 0, major))).toEqual([9, 0, 4]);
    expect(pcs(parseNumeral("V7", 0, major))).toEqual([7, 11, 2, 5]);
    expect(pcs(parseNumeral("ii7", 0, major))).toEqual([2, 5, 9, 0]);
    expect(pcs(parseNumeral("vii°", 0, major))).toEqual([11, 2, 5]);
    expect(pcs(parseNumeral("IVmaj7", 0, major))).toEqual([5, 9, 0, 4]);
  });

  it("reads flats and sharps from the major scale, so bVI in C minor is A-flat", () => {
    expect(pcs(parseNumeral("i", 0, minor))).toEqual([0, 3, 7]);
    expect(parseNumeral("bVI", 0, minor).root).toBe(8);
    expect(parseNumeral("VI", 0, minor).root).toBe(8);
    expect(parseNumeral("bVII", 0, major).root).toBe(10);
    expect(pcs(parseNumeral("bIII", 0, minor))).toEqual([3, 7, 10]);
    expect(pcs(parseNumeral("Vsus4", 7, major))).toEqual([2, 7, 9]);
  });

  it("refuses what it cannot read", () => {
    expect(() => parseNumeral("X", 0, major)).toThrow(/Roman numeral/);
    expect(() => parseNumeral("Iblah", 0, major)).toThrow(/suffix/);
    expect(() => scaleSteps("bebop")).toThrow(/must be one of/);
  });
});

describe("voice leading", () => {
  it("moves each voice as little as possible through I V vi IV", () => {
    const voicings = voiceLead(["I", "V", "vi", "IV"].map(symbol => parseNumeral(symbol, 0, major)));
    for (let k = 1; k < voicings.length; k++) {
      const moved = voicings[k].reduce((sum, pitch) => sum + Math.min(...voicings[k - 1].map(old => Math.abs(old - pitch))), 0);
      expect(moved).toBeLessThanOrEqual(5);
    }
    voicings.flat().forEach(pitch => expect(pitch).toBeGreaterThanOrEqual(50));
  });

  it("lays chords out in time with an optional bass and rhythm", () => {
    const chords = ["I", "IV"].map(symbol => parseNumeral(symbol, 0, major));
    const sustain = chordNotes({ chords, beatsPerChord: 4, rhythm: "sustain", bass: true, velocity: 90 });
    expect(sustain.filter(n => n.startTime === 4)).toHaveLength(4);
    expect(Math.min(...sustain.filter(n => n.startTime === 0).map(n => n.pitch)) % 12).toBe(0);
    expect(chordNotes({ chords, beatsPerChord: 4, rhythm: "stabs", bass: false, velocity: 90 })).toHaveLength(24);
    expect(chordNotes({ chords, beatsPerChord: 4, rhythm: "arpeggio", bass: false, velocity: 90 }).map(n => n.startTime).slice(0, 3)).toEqual([0, 0.5, 1]);
  });
});

describe("drums", () => {
  it("writes a style for several bars with swing on the off-16ths", () => {
    const notes = drumNotes({ style: "boom-bap", bars: 2, swing: 50, velocity: 110, notes: { kick: 36, snare: 38, closedHat: 42 } });
    expect(notes.filter(n => n.pitch === 38).map(n => n.startTime)).toEqual([1, 3, 5, 7]);
    const hats = notes.filter(n => n.pitch === 42).map(n => n.startTime);
    expect(hats).toContain(0.5);
    expect(notes.filter(n => n.pitch === 36).map(n => n.startTime)).toContain(1.792);
    expect(() => drumNotes({ style: "polka", bars: 1, swing: 0, velocity: 100, notes: {} })).toThrow(/style must be one of/);
  });

  it("finds Drum Rack pads by name and keeps open and closed hats apart", () => {
    const pads = [{ note: 36, name: "Kick Caltroit" }, { note: 38, name: "Snare Butta Soft" }, { note: 44, name: "Hihat Open Dusty" }, { note: 42, name: "Hihat Closed Tight" }, { note: 39, name: "Clap Surround" }];
    const map = mapDrumPads(["kick", "snare", "closedHat", "openHat", "clap", "rim"], pads);
    expect(map.kick.pad).toBe("Kick Caltroit");
    expect(map.closedHat.pad).toBe("Hihat Closed Tight");
    expect(map.openHat.pad).toBe("Hihat Open Dusty");
    expect(map.rim).toEqual({ note: 37, pad: null });
  });
});
