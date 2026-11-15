import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readMidiFile, writeMidiFile } from "../src/midi-file.js";
import { MidiFileTools } from "../src/midi-tools.js";

const notes = [
  { pitch: 36, startTime: 0, duration: 0.25, velocity: 110 },
  { pitch: 42, startTime: 0.5, duration: 0.125, velocity: 80 },
  { pitch: 38, startTime: 1, duration: 0.25, velocity: 100 },
  { pitch: 36, startTime: 1.75, duration: 0.25, velocity: 90 }
];

describe("MIDI file format", () => {
  it("round-trips notes, tempo, time signature, and track name", () => {
    const file = readMidiFile(writeMidiFile({ notes, name: "Beat", tempo: 124, timeSignature: { numerator: 7, denominator: 8 } }));
    expect(file.tempo).toBe(124);
    expect(file.timeSignature).toEqual({ numerator: 7, denominator: 8 });
    expect(file.tracks[1].name).toBe("Beat");
    expect(file.tracks[1].notes.map(({ channel: _channel, ...note }) => note)).toEqual([...notes].sort((a, b) => a.startTime - b.startTime));
  });

  it("keeps back-to-back repeats of the same pitch apart", () => {
    const repeated = [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }, { pitch: 60, startTime: 1, duration: 1, velocity: 100 }];
    expect(readMidiFile(writeMidiFile({ notes: repeated })).tracks[1].notes.map(n => [n.startTime, n.duration])).toEqual([[0, 1], [1, 1]]);
  });

  it("reads running status and note-on with velocity 0 as note-off (format 0)", () => {
    // MThd format 0, one track, 96 ticks per beat. MTrk: on C3 at 0, on E3 at 0 (running status), offs at 96 via velocity 0.
    const track = [0x00, 0x90, 60, 100, 0x00, 64, 90, 0x60, 60, 0, 0x00, 64, 0, 0x00, 0xff, 0x2f, 0x00];
    const bytes = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
    expect(readMidiFile(bytes).tracks[0].notes.map(n => [n.pitch, n.startTime, n.duration, n.velocity])).toEqual([[60, 0, 1, 100], [64, 0, 1, 90]]);
  });

  it("refuses files that are not plain MIDI files", () => {
    expect(() => readMidiFile(Buffer.from("RIFF0000"))).toThrow(/not a Standard MIDI File/);
    expect(() => readMidiFile(Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 0, 96]))).toThrow(/formats 0 and 1/);
  });
});

function fakeLive() {
  let clip: Array<[number, number, number, number, boolean, number]> | null = null;
  const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
  return {
    send: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      if (address === "/live/clip_slot/create_clip") clip = [];
      if (address === "/live/clip/add/notes") for (let k = 2; k < args.length; k += 5) clip!.push([Number(args[k]), Number(args[k + 1]), Number(args[k + 2]), Number(args[k + 3]), false, clip!.length + 1]);
    }),
    query: vi.fn(async (address: string) => {
      if (address === "/live/song/get/track_names") return { args: ["Keys"] };
      if (address === "/live/clip_slot/get/state") return { args: [0, 0, clip !== null, clip ? "" : null, false, false, false] };
      if (address === "/live/session_clip/get/notes") return { args: [0, 0, "Beat", ...(clip ?? notes.map((n, i) => [n.pitch, n.startTime, n.duration, n.velocity, i === 3, i + 1])).flat()] };
      if (address === "/live/song/get/tempo") return { args: [124] };
      if (address === "/live/song/get/signature_numerator") return { args: [4] };
      if (address === "/live/song/get/signature_denominator") return { args: [4] };
      throw new Error(`Unexpected query ${address}`);
    })
  };
}

const logger = { write: vi.fn() };

describe("MIDI file tools", () => {
  const folder = mkdtempSync(join(tmpdir(), "control-deck-midi-"));

  it("exports a clip, leaving out muted notes, and refuses to overwrite by default", async () => {
    const path = join(folder, "beat.mid");
    const tools = new MidiFileTools(fakeLive() as never, logger as never);
    expect(await tools.exportClipMidi({ trackIndex: 0, sceneIndex: 0, path })).toMatchObject({ ok: true, data: { notes: 3, mutedNotesSkipped: 1, tempo: 124 } });
    expect(readMidiFile(readFileSync(path)).tracks[1].notes).toHaveLength(3);
    expect(await tools.exportClipMidi({ trackIndex: 0, sceneIndex: 0, path })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/already exists/) } });
    expect(await tools.exportClipMidi({ trackIndex: 0, sceneIndex: 0, path: "beat.mid" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/absolute/) } });
  });

  it("imports a file into an empty slot and checks every note", async () => {
    const path = join(folder, "groove.mid");
    writeFileSync(path, writeMidiFile({ notes, name: "Groove", tempo: 120 }));
    const live = fakeLive();
    const result = await new MidiFileTools(live as never, logger as never).importMidiFile({ path, trackIndex: 0, sceneIndex: 0, expectedTrackName: "Keys" });
    expect(result).toMatchObject({ ok: true, data: { source: "Groove", notes: 4, lengthBeats: 4 } });
  });

  it("asks which track when a file has several with notes", async () => {
    const path = join(folder, "two.mid");
    const one = writeMidiFile({ notes, name: "A" });
    // Append a second note track by writing a format-1 file by hand: reuse the writer's track chunk.
    const file = readMidiFile(one);
    expect(file.tracks.filter(track => track.notes.length)).toHaveLength(1);
    const header = Buffer.from(one.subarray(0, 14)); header[11] = 3;
    const trackChunk = one.subarray(one.indexOf(Buffer.from("MTrk"), 22));
    writeFileSync(path, Buffer.concat([header, one.subarray(14), trackChunk]));
    const result = await new MidiFileTools(fakeLive() as never, logger as never).importMidiFile({ path, trackIndex: 0, sceneIndex: 0, expectedTrackName: "Keys" });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/2 tracks with notes; pass midiTrack/) } });
  });
});
