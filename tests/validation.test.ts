import { describe, expect, it } from "vitest";
import { noteNameToMidi, validateNotes } from "../src/validation.js";

describe("MIDI validation", () => {
  it("uses Ableton's C3=60 convention", () => expect(noteNameToMidi("C3")).toBe(60));
  it("supports accidentals", () => { expect(noteNameToMidi("Eb3")).toBe(63); expect(noteNameToMidi("F#4")).toBe(78); });
  it("normalizes and validates notes", () => expect(validateNotes([{ pitch: "C3", startTime: 0, duration: 1, velocity: 100 }])[0]).toMatchObject({ pitch: 60, mute: false }));
  it("rejects invalid velocity", () => expect(() => validateNotes([{ pitch: 60, startTime: 0, duration: 1, velocity: 128 }])).toThrow(/Invalid MIDI note/));
  it("rejects empty lists", () => expect(() => validateNotes([])).toThrow(/At least one/));
});
