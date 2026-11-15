import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { verifyAddedNotes } from "./arrangement-clips.js";
import { readMidiFile, writeMidiFile, type MidiNote } from "./midi-file.js";
import { chunkOscNotes, SESSION_ADD_NOTES_PER_DATAGRAM } from "./note-chunks.js";
import { nonNegativeInteger } from "./session-tools.js";
import { SongTools } from "./song-tools.js";
import { oscFloat, oscInt, type OscArgument, type ToolResult } from "./types.js";

const MIDI_EXTENSIONS = [".mid", ".midi"];
const MAX_IMPORT_NOTES = 10_000;

async function checkMidiPath(path: string, mustExist: boolean): Promise<void> {
  if (!path || path.includes("\0") || !isAbsolute(path)) throw new Error("The path must be absolute.");
  if (!MIDI_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Error("The file must end in .mid or .midi.");
  if (mustExist) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`No file at ${path}.`);
  } else {
    const folder = await stat(dirname(path)).catch(() => null);
    if (!folder?.isDirectory()) throw new Error(`The folder ${dirname(path)} does not exist.`);
  }
}

export class MidiFileTools extends SongTools {
  exportClipMidi(input: { trackIndex: number; sceneIndex: number; path: string; overwrite?: boolean }): Promise<ToolResult> {
    return this.read("export_clip_midi", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      await checkMidiPath(input.path, false);
      const exists = await stat(input.path).then(() => true, () => false);
      if (exists && input.overwrite !== true) throw new Error(`${input.path} already exists. Pass overwrite: true to replace it.`);
      const { clipName, notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      const tempo = Number((await this.live.query("/live/song/get/tempo")).args.at(-1));
      const numerator = Number((await this.live.query("/live/song/get/signature_numerator")).args.at(-1));
      const denominator = Number((await this.live.query("/live/song/get/signature_denominator")).args.at(-1));
      const playable = notes.filter(note => !note.mute);
      const bytes = writeMidiFile({ notes: playable, name: clipName || undefined, tempo, timeSignature: { numerator, denominator } });
      await writeFile(input.path, bytes);
      // Read the file back and check it holds every note.
      const check = readMidiFile(await readFile(input.path));
      const written = check.tracks.reduce((sum, track) => sum + track.notes.length, 0);
      if (written !== playable.length) throw new Error(`The file holds ${written} notes, not ${playable.length}.`);
      return { path: input.path, clipName, notes: playable.length, mutedNotesSkipped: notes.length - playable.length, tempo, timeSignature: `${numerator}/${denominator}`, bytes: bytes.length };
    });
  }

  /**
   * Create a Session MIDI clip in an empty slot and add notes in datagram-sized batches, checking every one.
   * prepare runs first (including for a dry run) and returns the notes, clip length, and a summary.
   */
  protected createClipWithNotes(tool: string, input: { trackIndex: number; sceneIndex: number; expectedTrackName: string; clipName?: string; dryRun?: boolean }, prepare: () => Promise<{ notes: MidiNote[]; lengthBeats: number; summary: Record<string, unknown> }>): Promise<ToolResult> {
    let notes: MidiNote[] = [];
    let length = 0;
    let summary: Record<string, unknown> = {};
    return this.change(tool, input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      ({ notes, lengthBeats: length, summary } = await prepare());
      if (!notes.length) throw new Error("There are no notes to write.");
      if (notes.length > MAX_IMPORT_NOTES) throw new Error(`That is ${notes.length} notes; at most ${MAX_IMPORT_NOTES} can be written at once.`);
      const lastEnd = Math.max(...notes.map(note => note.startTime + note.duration));
      if (!(length > 0) || lastEnd > length + 1e-6) throw new Error(`The clip length ${length} must cover the notes, which end at beat ${lastEnd}.`);
      const names = (await this.live.query("/live/song/get/track_names")).args.map(String);
      if (input.trackIndex >= names.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
      this.requireTrackName(names[input.trackIndex], input.expectedTrackName);
      const slot = (await this.live.query("/live/clip_slot/get/state", [oscInt(input.trackIndex), oscInt(input.sceneIndex)])).args;
      if (slot[2] === true) throw new Error(`Track ${input.trackIndex}, scene ${input.sceneIndex} already holds clip '${String(slot[3])}'.`);
      return { address: "/live/clip_slot/create_clip", args: [oscInt(input.trackIndex), oscInt(input.sceneIndex), oscFloat(length)], before: null };
    }, async () => {
      // The clip exists now; add the notes in datagram-sized batches, then check every one landed.
      const address = "/live/clip/add/notes";
      const prefix: OscArgument[] = [oscInt(input.trackIndex), oscInt(input.sceneIndex)];
      const encode = (note: MidiNote): OscArgument[] => [oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(Math.min(127, Math.max(1, Math.round(note.velocity)))), false];
      const batches = chunkOscNotes(this.live, notes, { address, prefix, encode, maxPerChunk: SESSION_ADD_NOTES_PER_DATAGRAM });
      for (const [index, batch] of batches.entries()) {
        try { await this.live.send(address, [...prefix, ...batch.flatMap(encode)]); } catch (error) {
          throw new Error(`The clip was created, but note batch ${index + 1} of ${batches.length} failed: ${error instanceof Error ? error.message : String(error)}. Delete the clip or add the rest.`);
        }
      }
      const { notes: inClip } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      verifyAddedNotes(notes.map(note => ({ ...note, velocity: Math.min(127, Math.max(1, Math.round(note.velocity))), mute: false })), inClip, `the new clip at track ${input.trackIndex}, scene ${input.sceneIndex}`);
      if (input.clipName) await this.live.send("/live/clip/set", [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, "", "name", input.clipName]);
      return { ...summary, notes: notes.length, lengthBeats: length, batches: batches.length, clipName: input.clipName ?? null };
    });
  }

  importMidiFile(input: { path: string; trackIndex: number; sceneIndex: number; expectedTrackName: string; midiTrack?: number; clipName?: string; lengthBeats?: number; dryRun?: boolean }): Promise<ToolResult> {
    return this.createClipWithNotes("import_midi_file", input, async () => {
      await checkMidiPath(input.path, true);
      const file = readMidiFile(await readFile(input.path));
      const withNotes = file.tracks.map((track, index) => ({ ...track, index })).filter(track => track.notes.length);
      if (!withNotes.length) throw new Error("The MIDI file has no notes.");
      let chosen = withNotes[0];
      if (input.midiTrack !== undefined) {
        const picked = file.tracks[input.midiTrack];
        if (!picked?.notes.length) throw new Error(`MIDI track ${input.midiTrack} has no notes. Tracks with notes: ${withNotes.map(track => `${track.index}${track.name ? ` (${track.name})` : ""}: ${track.notes.length}`).join(", ")}.`);
        chosen = { ...picked, index: input.midiTrack };
      } else if (withNotes.length > 1) {
        throw new Error(`The file has ${withNotes.length} tracks with notes; pass midiTrack. ${withNotes.map(track => `${track.index}${track.name ? ` (${track.name})` : ""}: ${track.notes.length} notes`).join(", ")}.`);
      }
      const lastEnd = Math.max(...chosen.notes.map(note => note.startTime + note.duration));
      return { notes: chosen.notes, lengthBeats: input.lengthBeats ?? Math.max(4, Math.ceil(lastEnd / 4) * 4), summary: { path: input.path, source: chosen.name ?? `track ${chosen.index}` } };
    });
  }
}
