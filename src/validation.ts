import { z } from "zod";
import type { MidiNote } from "./types.js";

export const trackIndexSchema = z.number().int().min(0);
export const sceneIndexSchema = z.number().int().min(0);
export const tempoSchema = z.number().min(20).max(999);

const NOTE_RE = /^([A-Ga-g])([#b]?)(-2|-1|[0-8])$/;
const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteNameToMidi(value: string): number {
  const match = NOTE_RE.exec(value.trim());
  if (!match) throw new Error(`Invalid note name: ${value}. Expected C3, F#4, or Bb2.`);
  const [, letter, accidental, octaveText] = match;
  let pitch = (Number(octaveText) + 2) * 12 + SEMITONES[letter.toUpperCase()];
  if (accidental === "#") pitch++;
  if (accidental === "b") pitch--;
  if (pitch < 0 || pitch > 127) throw new Error(`Note ${value} is outside MIDI range 0-127.`);
  return pitch;
}

export function validateNotes(notes: MidiNote[]): Array<Required<MidiNote> & { pitch: number }> {
  if (!Array.isArray(notes) || notes.length === 0) throw new Error("At least one MIDI note is required.");
  return notes.map((note, index) => {
    const pitch = typeof note.pitch === "string" ? noteNameToMidi(note.pitch) : note.pitch;
    const parsed = z.object({
      pitch: z.number().int().min(0).max(127),
      startTime: z.number().min(0),
      duration: z.number().positive(),
      velocity: z.number().int().min(1).max(127),
      mute: z.boolean().default(false)
    }).safeParse({ ...note, pitch });
    if (!parsed.success) throw new Error(`Invalid MIDI note at index ${index}: ${parsed.error.issues.map(i => i.message).join(", ")}`);
    return parsed.data;
  });
}

/** Check a note about to be sent to Live. velocityMin is 0 when the velocity is carried over unchanged. */
export function assertOutgoingNote(note: { pitch: number; startTime: number; duration: number; velocity: number }, velocityMin: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new Error("Pitch must be an integer from 0 to 127.");
  if (!Number.isFinite(note.startTime) || note.startTime < 0) throw new Error("Note start must be a non-negative number of beats.");
  if (!Number.isFinite(note.duration) || note.duration <= 0) throw new Error("Note duration must be positive.");
  if (!Number.isInteger(note.velocity) || note.velocity < velocityMin || note.velocity > 127) throw new Error(`Velocity must be an integer from ${velocityMin} to 127.`);
}
