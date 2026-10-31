import { describe, expect, it } from "vitest";
import { notesStartingInRange, parseArrangementNotes, resolveArrangementClip, verifyAddedNotes, verifyRemovedNotes, type ArrangementClipDescriptor, type ArrangementNote } from "../src/arrangement-clips.js";

const clip = (index: number, startBeats: number, kind: ArrangementClipDescriptor["kind"] = "midi"): ArrangementClipDescriptor => ({ index, name: "Clip", startBeats, endBeats: startBeats + 4, lengthBeats: 4, kind });
const note = (overrides: Partial<ArrangementNote>): ArrangementNote => ({ noteId: 1, pitch: 60, startTime: 0, duration: 1, velocity: 100, mute: false, ...overrides });

describe("arrangement note replies", () => {
  it("sorts notes and rejects a reply for a different clip", () => {
    const parsed = parseArrangementNotes([0, 1, 8, 12, "midi", 64, 1, 0.5, 90.4, false, 2, 60, 0, 1, 100, 0, 1], { trackIndex: 0, clipIndex: 1 });
    expect(parsed.notes.map(item => item.noteId)).toEqual([1, 2]);
    expect(parsed.notes[1].velocity).toBe(90.4);
    expect(parsed.notes[0].mute).toBe(false);
    expect(() => parseArrangementNotes([0, 2, 8, 12, "midi"], { trackIndex: 0, clipIndex: 1 })).toThrow(/not track 0 clip 1/);
    expect(() => parseArrangementNotes([0, 1, 8, 12, "midi", 60], { trackIndex: 0, clipIndex: 1 })).toThrow(/groups of pitch/);
  });

  it("refuses a clip address that disagrees with itself or matches two clips", () => {
    const clips = [clip(0, 0), clip(1, 8), clip(2, 8)];
    expect(resolveArrangementClip(clips, { clipIndex: 1, startBeats: 8 }).index).toBe(1);
    expect(() => resolveArrangementClip(clips, { clipIndex: 1, startBeats: 0 })).toThrow(/starts at 8/);
    expect(() => resolveArrangementClip(clips, { startBeats: 8 })).toThrow(/Multiple/);
    expect(() => resolveArrangementClip(clips, {})).toThrow(/clipIndex or startBeats/);
  });

  it("treats the end of a removal range as exclusive and keeps notes outside it", () => {
    const notes = [note({ noteId: 1, startTime: 1 }), note({ noteId: 2, pitch: 60, startTime: 1.5 }), note({ noteId: 3, pitch: 67, startTime: 1 })];
    expect(notesStartingInRange(notes, { fromPitch: 60, pitchSpan: 1, fromTime: 1, timeSpan: 0.5 }).map(item => item.noteId)).toEqual([1]);
    expect(() => verifyRemovedNotes(notes, [1], [note({ noteId: 2, startTime: 1.5 }), note({ noteId: 3, pitch: 62, startTime: 1 })])).toThrow(/outside the requested range/);
  });

  it("lets one clip note satisfy only one requested note", () => {
    const requested = [
      { pitch: 60, startTime: 0, duration: 1, velocity: 100, mute: false },
      { pitch: 60, startTime: 0, duration: 1, velocity: 100, mute: false }
    ];
    expect(() => verifyAddedNotes(requested, [note({ velocity: 100.2 })])).toThrow(/1 of 2/);
    expect(() => verifyAddedNotes([requested[0]], [note({ velocity: 100 }), note({ noteId: 9, pitch: 72, startTime: 2 })])).not.toThrow();
  });
});
