import type { OscAtom } from "./types.js";

export interface ClipNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

/** Parse a `/live/clip/get/notes` reply: `[trackIndex, sceneIndex, (pitch, start, duration, velocity, mute)*]`. */
export function parseNoteReply(args: OscAtom[], trackIndex: number, sceneIndex: number): ClipNote[] {
  if (Number(args[0]) !== trackIndex || Number(args[1]) !== sceneIndex) {
    throw new Error(`Note reply addressed clip ${args[0]}:${args[1]}, expected ${trackIndex}:${sceneIndex}.`);
  }
  const values = args.slice(2);
  if (values.length % 5 !== 0) throw new Error(`Malformed note reply: ${values.length} values is not a multiple of 5.`);
  const notes: ClipNote[] = [];
  for (let offset = 0; offset < values.length; offset += 5) {
    const [pitch, startTime, duration, velocity, mute] = values.slice(offset, offset + 5);
    const note = { pitch: Number(pitch), startTime: Number(startTime), duration: Number(duration), velocity: Number(velocity), mute: mute === true || mute === 1 };
    if (![note.pitch, note.startTime, note.duration, note.velocity].every(Number.isFinite)) throw new Error(`Malformed note reply at note ${offset / 5}.`);
    notes.push(note);
  }
  return sortNotes(notes);
}

export function sortNotes<T extends { startTime: number; pitch: number }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}
