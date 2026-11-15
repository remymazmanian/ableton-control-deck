import type { ArrangementNote } from "./arrangement-clips.js";
import { verifyModifiedNotes } from "./arrangement-clips.js";
import { AutomationTools } from "./automation-tools.js";
import { ARRANGEMENT_MODIFY_NOTES_PER_DATAGRAM, chunkOscNotes } from "./note-chunks.js";
import type { ClipTarget } from "./session-tools.js";
import { oscFloat, oscInt, type OscArgument, type ToolResult } from "./types.js";
import { noteNameToMidi } from "./validation.js";

export const QUANTIZE_GRIDS = ["1/4", "1/8", "1/8T", "1/8+1/8T", "1/16", "1/16T", "1/16+1/16T", "1/32"] as const;
export type QuantizeGrid = typeof QUANTIZE_GRIDS[number];

/** A small seeded random generator (mulberry32), so a humanize with the same seed gives the same result. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NoteFilter { fromPitch?: number; toPitch?: number; fromTime?: number; toTime?: number }

/** Notes inside the pitch range (inclusive) and starting inside the time range (end exclusive). */
export function selectNotes(notes: readonly ArrangementNote[], filter: NoteFilter): ArrangementNote[] {
  const low = filter.fromPitch ?? 0, high = filter.toPitch ?? 127, start = filter.fromTime ?? 0, end = filter.toTime ?? Infinity;
  if (low > high) throw new Error("fromPitch must not be above toPitch.");
  if (start >= end) throw new Error("fromTime must be before toTime.");
  return notes.filter(note => note.pitch >= low && note.pitch <= high && note.startTime >= start && note.startTime < end);
}

export function transposeNotes(notes: readonly ArrangementNote[], semitones: number): ArrangementNote[] {
  if (!Number.isInteger(semitones) || semitones === 0 || Math.abs(semitones) > 127) throw new Error("semitones must be a whole number from -127 to 127, not 0.");
  const out = notes.map(note => ({ ...note, pitch: note.pitch + semitones }));
  const outside = out.filter(note => note.pitch < 0 || note.pitch > 127);
  if (outside.length) throw new Error(`${outside.length} note(s) would land outside MIDI pitches 0-127. Transpose by less, or narrow the pitch range.`);
  return out;
}

/** Nudge start times by up to ±timing beats and velocities by up to ±velocity, keeping notes inside the clip and 1-127. */
export function humanizeNotes(notes: readonly ArrangementNote[], options: { timing: number; velocity: number; seed: number; clipLength: number }): ArrangementNote[] {
  const { timing, velocity, seed, clipLength } = options;
  if (!(timing >= 0 && timing <= 0.25)) throw new Error("timing must be from 0 to 0.25 beats.");
  if (!(Number.isInteger(velocity) && velocity >= 0 && velocity <= 64)) throw new Error("velocity must be a whole number from 0 to 64.");
  if (timing === 0 && velocity === 0) throw new Error("Set timing, velocity, or both above 0.");
  const random = seededRandom(seed);
  return notes.map(note => {
    const shift = (random() * 2 - 1) * timing;
    const startTime = Math.min(Math.max(0, note.startTime + shift), Math.max(0, clipLength - note.duration));
    const change = Math.round((random() * 2 - 1) * velocity);
    return { ...note, startTime: Math.round(startTime * 10000) / 10000, velocity: Math.min(127, Math.max(1, Math.round(note.velocity) + change)) };
  });
}

export class NoteTools extends AutomationTools {
  /** Send changed notes to a Session clip in datagram-sized batches and confirm every one. */
  private applyNoteEdits(tool: string, input: ClipTarget & { dryRun?: boolean }, plan: () => Promise<{ before: ArrangementNote[]; desired: ArrangementNote[]; summary: Record<string, unknown> }>): Promise<ToolResult> {
    let desired: ArrangementNote[] = [];
    let summary: Record<string, unknown> = {};
    return this.change(tool, input, input.dryRun ?? false, async () => {
      await this.requireClip(input);
      const result = await plan();
      desired = result.desired;
      summary = result.summary;
      if (!desired.length) throw new Error("No notes match; nothing to change.");
      const address = "/live/session_clip/modify/notes";
      const prefix: OscArgument[] = [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName];
      const encode = (note: ArrangementNote): OscArgument[] => [oscInt(note.noteId), oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(Math.round(note.velocity)), note.mute];
      const [first, ...rest] = chunkOscNotes(this.live, desired, { address, prefix, encode, maxPerChunk: ARRANGEMENT_MODIFY_NOTES_PER_DATAGRAM }).map(chunk => [...prefix, ...chunk.flatMap(encode)]);
      return { address, args: first, before: result.before, moreBatches: rest };
    }, async () => {
      const { notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      verifyModifiedNotes(desired.map(note => ({ ...note, velocity: Math.round(note.velocity) })), notes);
      return { ...summary, notesChanged: desired.length, noteCountInClip: notes.length };
    });
  }

  transposeClipNotes(input: ClipTarget & NoteFilter & { semitones: number; dryRun?: boolean }): Promise<ToolResult> {
    return this.applyNoteEdits("transpose_clip_notes", input, async () => {
      const { notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      const chosen = selectNotes(notes, input);
      return { before: notes, desired: transposeNotes(chosen, input.semitones), summary: { semitones: input.semitones } };
    });
  }

  humanizeClipNotes(input: ClipTarget & NoteFilter & { timing?: number; velocity?: number; seed?: number; dryRun?: boolean }): Promise<ToolResult> {
    const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
    return this.applyNoteEdits("humanize_clip_notes", input, async () => {
      const { notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      const chosen = selectNotes(notes, input);
      const desired = humanizeNotes(chosen, { timing: input.timing ?? 0.01, velocity: input.velocity ?? 8, seed, clipLength: Number(clip.props.length) });
      return { before: notes, desired, summary: { seed, timing: input.timing ?? 0.01, velocity: input.velocity ?? 8, note: "Run again with the same seed to get the same result." } };
    });
  }

  quantizeClip(input: ClipTarget & { grid: QuantizeGrid; amount?: number; pitch?: number | string; dryRun?: boolean }): Promise<ToolResult> {
    const amount = input.amount ?? 100;
    return this.change("quantize_clip", input, input.dryRun ?? false, async () => {
      if (!QUANTIZE_GRIDS.includes(input.grid)) throw new Error(`grid must be one of: ${QUANTIZE_GRIDS.join(", ")}.`);
      if (!(amount >= 0 && amount <= 100)) throw new Error("amount is a percentage from 0 to 100.");
      await this.requireClip(input);
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      const pitch = input.pitch === undefined ? -1 : typeof input.pitch === "string" ? noteNameToMidi(input.pitch) : input.pitch;
      if (!Number.isInteger(pitch) || pitch < -1 || pitch > 127) throw new Error("pitch must be 0-127 or a note name such as C1.");
      const before = clip.kind === "midi" ? (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes : [];
      return { address: "/live/clip/quantize", args: [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName, input.grid, oscFloat(amount / 100), oscInt(pitch)], before: { kind: clip.kind, notes: before } };
    }, async before => {
      if (before.kind !== "midi") return { grid: input.grid, amount, kind: before.kind, note: "Live quantized the audio clip's warp markers." };
      const after = (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes;
      const moved = after.filter(note => { const was = before.notes.find(old => old.noteId === note.noteId); return was && Math.abs(was.startTime - note.startTime) > 1e-6; });
      return { grid: input.grid, amount, notesMoved: moved.length, noteCountInClip: after.length, notes: after };
    });
  }

  duplicateClipLoop(input: ClipTarget & { dryRun?: boolean }): Promise<ToolResult> {
    return this.change("duplicate_clip_loop", input, input.dryRun ?? false, async () => {
      await this.requireClip(input);
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      if (clip.kind !== "midi") throw new Error("Duplicating the loop needs a MIDI clip.");
      const notes = (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes;
      return { address: "/live/clip/duplicate_loop", args: [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName], before: { loopStart: Number(clip.props.loop_start), loopEnd: Number(clip.props.loop_end), notes: notes.length } };
    }, async before => {
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      const loopEnd = Number(clip.props.loop_end);
      const expected = before.loopEnd + (before.loopEnd - before.loopStart);
      if (Math.abs(loopEnd - expected) > 1e-6) throw new Error(`The loop ends at ${loopEnd}, not ${expected}.`);
      const notes = (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes;
      return { loopStart: Number(clip.props.loop_start), loopEnd, lengthBeats: Number(clip.props.length), notesBefore: before.notes, notesAfter: notes.length };
    });
  }

  cropClip(input: ClipTarget & { confirm: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("crop_clip", input, input.dryRun ?? false, async () => {
      if (input.confirm !== true && !(input.dryRun ?? false)) throw new Error("crop_clip removes everything outside the loop and needs confirm=true.");
      await this.requireClip(input);
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      return { address: "/live/clip/crop", args: [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName, input.confirm === true], before: { length: Number(clip.props.length), loopStart: Number(clip.props.loop_start), loopEnd: Number(clip.props.loop_end) } };
    }, async before => {
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      const after = { length: Number(clip.props.length), loopStart: Number(clip.props.loop_start), loopEnd: Number(clip.props.loop_end), startMarker: Number(clip.props.start_marker), endMarker: Number(clip.props.end_marker) };
      // A cropped clip starts at 0. If Live left the region where it was, nothing was cropped.
      if (Math.abs(after.loopStart) > 1e-6 && Math.abs(after.startMarker) > 1e-6) throw new Error(`Live did not crop the clip: the loop still starts at ${after.loopStart}.`);
      const notes = clip.kind === "midi" ? (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes : undefined;
      return { before, after, ...(notes ? { noteCount: notes.length } : {}) };
    });
  }
}
