import { describe, expect, it, vi } from "vitest";
import { humanizeNotes, NoteTools, seededRandom, selectNotes, transposeNotes } from "../src/note-tools.js";

const note = (noteId: number, pitch: number, startTime: number, velocity = 100) => ({ noteId, pitch, startTime, duration: 0.25, velocity, mute: false });
const notes = [note(1, 36, 0), note(2, 38, 1), note(3, 42, 1.5, 80), note(4, 60, 2)];

describe("note helpers", () => {
  it("selects notes by pitch range (inclusive) and start time (end exclusive)", () => {
    expect(selectNotes(notes, { fromPitch: 36, toPitch: 42 }).map(n => n.noteId)).toEqual([1, 2, 3]);
    expect(selectNotes(notes, { fromTime: 1, toTime: 2 }).map(n => n.noteId)).toEqual([2, 3]);
    expect(() => selectNotes(notes, { fromPitch: 50, toPitch: 40 })).toThrow(/fromPitch/);
  });

  it("transposes, refusing anything that would leave 0-127", () => {
    expect(transposeNotes(notes, 12).map(n => n.pitch)).toEqual([48, 50, 54, 72]);
    expect(() => transposeNotes(notes, 70)).toThrow(/1 note\(s\) would land outside/);
    expect(() => transposeNotes(notes, 0)).toThrow(/not 0/);
  });

  it("humanizes within the limits, the same way for the same seed", () => {
    const a = humanizeNotes(notes, { timing: 0.02, velocity: 10, seed: 7, clipLength: 4 });
    expect(humanizeNotes(notes, { timing: 0.02, velocity: 10, seed: 7, clipLength: 4 })).toEqual(a);
    expect(humanizeNotes(notes, { timing: 0.02, velocity: 10, seed: 8, clipLength: 4 })).not.toEqual(a);
    a.forEach((moved, index) => {
      expect(Math.abs(moved.startTime - notes[index].startTime)).toBeLessThanOrEqual(0.02 + 1e-9);
      expect(Math.abs(moved.velocity - notes[index].velocity)).toBeLessThanOrEqual(10);
      expect(moved.startTime).toBeGreaterThanOrEqual(0);
      expect(moved.pitch).toBe(notes[index].pitch);
    });
    expect(() => humanizeNotes(notes, { timing: 0, velocity: 0, seed: 1, clipLength: 4 })).toThrow(/above 0/);
  });

  it("spreads the seeded generator over 0-1", () => {
    const random = seededRandom(42);
    const values = Array.from({ length: 1000 }, random);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(values.reduce((a, b) => a + b, 0) / values.length).toBeCloseTo(0.5, 1);
  });
});

function fakeLive() {
  let clipNotes = notes.map(n => [n.pitch, n.startTime, n.duration, n.velocity, n.mute, n.noteId]);
  let props: Record<string, unknown> = { name: "Beat", length: 4, loop_start: 0, loop_end: 4 };
  const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
  return {
    sent: [] as string[],
    send: vi.fn(async function (address: string, raw: unknown[] = []) {
      const args = plain(raw);
      if (address === "/live/session_clip/modify/notes") {
        for (let k = 4; k < args.length; k += 6) {
          const entry = clipNotes.find(n => n[5] === args[k])!;
          entry.splice(0, 5, Number(args[k + 1]), Number(args[k + 2]), Number(args[k + 3]), Number(args[k + 4]), args[k + 5] === true);
        }
      }
      if (address === "/live/clip/quantize") clipNotes = clipNotes.map(n => [n[0], Math.round(Number(n[1])), ...n.slice(2)]);
      if (address === "/live/clip/duplicate_loop") {
        clipNotes = [...clipNotes, ...clipNotes.map(n => [n[0], Number(n[1]) + 4, n[2], n[3], n[4], Number(n[5]) + 100])];
        props = { ...props, length: 8, loop_end: 8 };
      }
    }),
    query: vi.fn(async (address: string) => {
      if (address === "/live/song/get/track_names") return { args: ["Drums"] };
      if (address === "/live/clip_slot/get/state") return { args: [0, 0, true, "Beat", false, false, false] };
      if (address === "/live/clip/get/properties") return { args: [0, 0, "midi", ...Object.entries(props).flat()] };
      if (address === "/live/session_clip/get/notes") return { args: [0, 0, "Beat", ...clipNotes.flat()] };
      throw new Error(`Unexpected query ${address}`);
    })
  };
}

const beat = { trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat" };
const logger = { write: vi.fn() };

describe("note tools", () => {
  it("transposes only the chosen pitch range and reads every note back", async () => {
    const result = await new NoteTools(fakeLive() as never, logger as never).transposeClipNotes({ ...beat, semitones: -2, fromPitch: 36, toPitch: 38 });
    expect(result).toMatchObject({ ok: true, data: { semitones: -2, notesChanged: 2, noteCountInClip: 4 } });
  });

  it("humanizes and reports the seed", async () => {
    const result = await new NoteTools(fakeLive() as never, logger as never).humanizeClipNotes({ ...beat, seed: 99 });
    expect(result).toMatchObject({ ok: true, data: { seed: 99, notesChanged: 4 } });
  });

  it("quantizes and counts the notes Live moved", async () => {
    const result = await new NoteTools(fakeLive() as never, logger as never).quantizeClip({ ...beat, grid: "1/4" });
    expect(result).toMatchObject({ ok: true, data: { grid: "1/4", amount: 100, notesMoved: 1 } });
  });

  it("duplicates the loop and checks it doubled", async () => {
    const result = await new NoteTools(fakeLive() as never, logger as never).duplicateClipLoop(beat);
    expect(result).toMatchObject({ ok: true, data: { loopEnd: 8, notesBefore: 4, notesAfter: 8 } });
  });

  it("refuses an empty selection, a bad grid, and cropping without confirm", async () => {
    const live = fakeLive();
    const tools = new NoteTools(live as never, logger as never);
    expect(await tools.transposeClipNotes({ ...beat, semitones: 1, fromPitch: 100 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No notes match/) } });
    expect(await tools.quantizeClip({ ...beat, grid: "1/12" as never })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/grid must be one of/) } });
    expect(await tools.cropClip({ ...beat, confirm: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(live.send).not.toHaveBeenCalled();
  });
});
