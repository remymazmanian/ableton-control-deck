const CLIP_FIELDS = 4;
const NOTE_FIELDS = 6;
const NOTE_HEADER = 5;
export const MAX_ARRANGEMENT_BEATS = 1_576_800;
export const MAX_NOTES_PER_CALL = 256;
const TIME_TOLERANCE = 0.001;

export interface ArrangementNote {
  noteId: number;
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

export interface ArrangementNoteRange {
  fromPitch: number;
  pitchSpan: number;
  fromTime: number;
  timeSpan: number;
}

export interface ParsedArrangementNotes {
  trackIndex: number;
  clipIndex: number;
  startBeats: number;
  endBeats: number;
  kind: ArrangementClipDescriptor["kind"];
  notes: ArrangementNote[];
}

export interface ArrangementClipDescriptor {
  index: number;
  name: string;
  startBeats: number;
  endBeats: number;
  lengthBeats: number;
  kind: "midi" | "audio" | "unknown";
}

export function parseArrangementClips(args: readonly unknown[], expectedTrackIndex?: number): ArrangementClipDescriptor[] {
  if (args.length < 1) throw new Error("Arrangement clip reply is missing the track index.");
  if (expectedTrackIndex !== undefined && Number(args[0]) !== expectedTrackIndex) {
    throw new Error(`Arrangement clip reply was addressed to track ${String(args[0])}, not track ${expectedTrackIndex}.`);
  }
  const body = args.slice(1);
  if (body.length % CLIP_FIELDS !== 0) {
    throw new Error("Arrangement clip reply is missing clip type. Reinstall the Control Deck remote script and restart Live.");
  }
  const clips: ArrangementClipDescriptor[] = [];
  for (let offset = 0; offset < body.length; offset += CLIP_FIELDS) {
    const name = body[offset];
    if (typeof name !== "string") throw new Error("Arrangement clip name was not text.");
    const startBeats = finiteNumber(body[offset + 1], "clip start");
    const endBeats = finiteNumber(body[offset + 2], "clip end");
    clips.push({
      index: clips.length,
      name,
      startBeats,
      endBeats,
      lengthBeats: endBeats - startBeats,
      kind: clipKind(body[offset + 3])
    });
  }
  return clips;
}

export function findCreatedMidiClip(clips: readonly ArrangementClipDescriptor[], startBeats: number, lengthBeats: number, name?: string): ArrangementClipDescriptor {
  const endBeats = startBeats + lengthBeats;
  const matches = clips.filter(clip => clip.kind === "midi" && Math.abs(clip.startBeats - startBeats) < TIME_TOLERANCE && Math.abs(clip.endBeats - endBeats) < TIME_TOLERANCE);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "Live did not confirm the arrangement MIDI clip." : "More than one arrangement MIDI clip matches that start and length.");
  }
  const clip = matches[0];
  if (name !== undefined && clip.name !== name) throw new Error(`Arrangement clip name verification failed: expected '${name}', found '${clip.name}'.`);
  return clip;
}

export function resolveArrangementClip(clips: readonly ArrangementClipDescriptor[], address: { clipIndex?: number; startBeats?: number }): ArrangementClipDescriptor {
  const { clipIndex, startBeats } = address;
  if (clipIndex === undefined && startBeats === undefined) throw new Error("Provide clipIndex or startBeats to choose the arrangement clip.");
  if (clipIndex !== undefined) {
    if (!Number.isInteger(clipIndex) || clipIndex < 0) throw new Error("clipIndex must be a non-negative integer.");
    const byIndex = clips[clipIndex];
    if (!byIndex) throw new Error(`Arrangement clip index ${clipIndex} does not exist on this track.`);
    if (startBeats !== undefined && Math.abs(byIndex.startBeats - startBeats) >= TIME_TOLERANCE) {
      throw new Error(`Arrangement clip ${clipIndex} starts at ${byIndex.startBeats} beats, not ${startBeats}.`);
    }
    return byIndex;
  }
  const matches = clips.filter(clip => Math.abs(clip.startBeats - (startBeats as number)) < TIME_TOLERANCE);
  if (matches.length === 0) throw new Error(`No arrangement clip starts at ${startBeats} beats.`);
  if (matches.length > 1) throw new Error(`Multiple arrangement clips start at ${startBeats} beats; pass clipIndex.`);
  return matches[0];
}

export function parseArrangementNotes(args: readonly unknown[], expected: { trackIndex: number; clipIndex: number }): ParsedArrangementNotes {
  if (args.length < NOTE_HEADER) throw new Error("Arrangement note reply is truncated.");
  const trackIndex = wholeNumber(args[0], "track index");
  const clipIndex = wholeNumber(args[1], "clip index");
  if (trackIndex !== expected.trackIndex || clipIndex !== expected.clipIndex) {
    throw new Error(`Note reply was addressed to track ${trackIndex} clip ${clipIndex}, not track ${expected.trackIndex} clip ${expected.clipIndex}.`);
  }
  const body = args.slice(NOTE_HEADER);
  if (body.length % NOTE_FIELDS !== 0) throw new Error("Arrangement note reply is not groups of pitch, start, duration, velocity, mute, and note id.");
  const notes: ArrangementNote[] = [];
  for (let offset = 0; offset < body.length; offset += NOTE_FIELDS) {
    const pitch = wholeNumber(body[offset], "pitch");
    if (pitch < 0 || pitch > 127) throw new Error(`Arrangement note pitch ${pitch} is outside 0-127.`);
    const noteId = wholeNumber(body[offset + 5], "note id");
    if (noteId < 0) throw new Error("Note id must be a non-negative integer.");
    notes.push({
      noteId,
      pitch,
      startTime: finiteNumber(body[offset + 1], "note start"),
      duration: finiteNumber(body[offset + 2], "note duration"),
      velocity: finiteNumber(body[offset + 3], "velocity"),
      mute: muteFlag(body[offset + 4])
    });
  }
  notes.sort((left, right) => left.startTime - right.startTime || left.pitch - right.pitch || left.noteId - right.noteId);
  return {
    trackIndex,
    clipIndex,
    startBeats: finiteNumber(args[2], "clip start"),
    endBeats: finiteNumber(args[3], "clip end"),
    kind: clipKind(args[4]),
    notes
  };
}

export function notesStartingInRange(notes: readonly ArrangementNote[], range: ArrangementNoteRange): ArrangementNote[] {
  return notes.filter(note =>
    note.pitch >= range.fromPitch && note.pitch < range.fromPitch + range.pitchSpan
    && note.startTime >= range.fromTime && note.startTime < range.fromTime + range.timeSpan
  );
}

export function verifyAddedNotes(requested: ReadonlyArray<{ pitch: number; startTime: number; duration: number; velocity: number; mute: boolean }>, actual: readonly ArrangementNote[]): void {
  const used = new Set<number>();
  const missing = requested.filter(note => {
    const index = actual.findIndex((candidate, position) => !used.has(position) && sameRequestedNote(note, candidate));
    if (index < 0) return true;
    used.add(index);
    return false;
  });
  if (!missing.length) return;
  const sample = missing.slice(0, 5).map(note => `pitch ${note.pitch} at ${note.startTime} (duration ${note.duration}, velocity ${note.velocity}${note.mute ? ", muted" : ""})`).join("; ");
  throw new Error(`Note verification failed: ${missing.length} of ${requested.length} requested notes are not in the arrangement clip after writing. Missing: ${sample}`);
}

export function verifyModifiedNotes(desired: readonly ArrangementNote[], actual: readonly ArrangementNote[]): void {
  for (const note of desired) {
    const matches = actual.filter(candidate => candidate.noteId === note.noteId);
    if (matches.length !== 1) throw new Error(`Note verification failed: note id ${note.noteId} was ${matches.length === 0 ? "missing" : "ambiguous"} after modification.`);
    if (!sameRequestedNote(note, matches[0])) {
      const found = matches[0];
      throw new Error(`Note verification failed: note id ${note.noteId} is pitch ${found.pitch} at ${found.startTime}, duration ${found.duration}, velocity ${found.velocity}, mute ${found.mute}.`);
    }
  }
}

export function verifyRemovedNotes(before: readonly ArrangementNote[], removedIds: readonly number[], after: readonly ArrangementNote[]): void {
  const afterIds = new Set(after.map(note => note.noteId));
  const stillThere = removedIds.filter(id => afterIds.has(id));
  if (stillThere.length) throw new Error(`Note removal failed: ${stillThere.length} note(s) are still in the clip (${stillThere.slice(0, 5).join(", ")}).`);
  const removed = new Set(removedIds);
  for (const note of before) {
    if (removed.has(note.noteId)) continue;
    const match = after.find(candidate => candidate.noteId === note.noteId);
    if (!match || !sameRequestedNote({ ...note, velocity: Math.round(note.velocity) }, match)) {
      throw new Error(`Note removal changed note ${note.noteId}, which was outside the requested range.`);
    }
  }
}

function sameRequestedNote(requested: { pitch: number; startTime: number; duration: number; velocity: number; mute: boolean }, actual: ArrangementNote): boolean {
  return actual.pitch === requested.pitch
    && Math.abs(actual.startTime - requested.startTime) < TIME_TOLERANCE
    && Math.abs(actual.duration - requested.duration) < TIME_TOLERANCE
    && Math.round(actual.velocity) === requested.velocity
    && actual.mute === requested.mute;
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Arrangement ${label} was not an integer.`);
  return value;
}

function muteFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`Arrangement note mute flag was not a boolean.`);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Arrangement ${label} was not a finite number.`);
  return value;
}

function clipKind(value: unknown): ArrangementClipDescriptor["kind"] {
  if (value === "midi" || value === "audio" || value === "unknown") return value;
  throw new Error(`Unexpected arrangement clip type '${String(value)}'.`);
}
