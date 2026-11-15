import { MidiFileTools } from "./midi-tools.js";
import { keyToRoot } from "./song-tools.js";
import { chordNotes, DRUM_STYLES, drumNotes, mapDrumPads, parseNumeral, scaleSteps, SCALES, type ChordRhythm } from "./theory.js";
import { oscInt, type ToolResult } from "./types.js";
import { noteNameToMidi } from "./validation.js";

interface SlotInput { trackIndex: number; sceneIndex: number; expectedTrackName: string; clipName?: string; dryRun?: boolean }

export class TheoryTools extends MidiFileTools {
  /** The song's key and scale from Live 12, when the scale is one these tools know. */
  private async songKey(): Promise<{ root: number; scale: string } | null> {
    try {
      const state = JSON.parse(String((await this.live.query("/live/song_settings/get")).args[0]));
      const scale = String(state.scaleName ?? "").toLowerCase();
      if (state.rootNote === null || !SCALES[scale]) return null;
      return { root: Number(state.rootNote), scale };
    } catch { return null; }
  }

  writeChordProgression(input: SlotInput & { progression: string; key?: string | number; scale?: string; beatsPerChord?: number; rhythm?: ChordRhythm; bass?: boolean; velocity?: number; centre?: number | string }): Promise<ToolResult> {
    return this.createClipWithNotes("write_chord_progression", input, async () => {
      const fromSong = input.key === undefined || input.scale === undefined ? await this.songKey() : null;
      if ((input.key === undefined || input.scale === undefined) && !fromSong) throw new Error("Pass key and scale, or set the song's key and scale in Live first.");
      const root = input.key !== undefined ? keyToRoot(input.key) : fromSong!.root;
      const scaleName = input.scale ?? fromSong!.scale;
      const steps = scaleSteps(scaleName);
      const symbols = input.progression.trim().split(/[\s,|-]+/).filter(Boolean);
      if (!symbols.length || symbols.length > 64) throw new Error("progression needs 1 to 64 chords, such as \"I V vi IV\".");
      const chords = symbols.map(symbol => parseNumeral(symbol, root, steps));
      const beatsPerChord = input.beatsPerChord ?? 4;
      if (!(beatsPerChord >= 0.5 && beatsPerChord <= 32)) throw new Error("beatsPerChord must be from 0.5 to 32.");
      const velocity = input.velocity ?? 96;
      const centre = typeof input.centre === "string" ? noteNameToMidi(input.centre) : input.centre ?? 60;
      if (!Number.isInteger(centre) || centre < 24 || centre > 96) throw new Error("centre must be a pitch from 24 to 96, or a note name such as C3.");
      const notes = chordNotes({ chords, beatsPerChord, rhythm: input.rhythm ?? "sustain", bass: input.bass ?? false, velocity, centre });
      const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      return {
        notes,
        lengthBeats: chords.length * beatsPerChord,
        summary: { key: names[root], scale: scaleName, keyFrom: input.key !== undefined && input.scale !== undefined ? "input" : "song", chords: chords.map(chord => `${chord.symbol} (${names[chord.root]})`), rhythm: input.rhythm ?? "sustain" }
      };
    });
  }

  writeDrumPattern(input: SlotInput & { style: string; bars?: number; swing?: number; velocity?: number; usePads?: boolean; notes?: Record<string, number> }): Promise<ToolResult> {
    return this.createClipWithNotes("write_drum_pattern", input, async () => {
      const pattern = DRUM_STYLES[input.style];
      if (!pattern) throw new Error(`style must be one of: ${Object.keys(DRUM_STYLES).join(", ")}.`);
      const bars = input.bars ?? 2;
      if (!Number.isInteger(bars) || bars < 1 || bars > 16) throw new Error("bars must be a whole number from 1 to 16.");
      const instruments = Object.keys(pattern);
      let mapping = mapDrumPads(instruments, []);
      let drumRack: string | null = null;
      if (input.usePads ?? true) {
        // Look for a Drum Rack as the first device, or inside the first rack's first chain (as factory kits are).
        for (const path of ["0", "0/0/0"]) {
          try {
            const rack = JSON.parse(String((await this.live.query("/live/rack/get", ["track", oscInt(input.trackIndex), path])).args[0]));
            if (rack.isDrumRack && rack.drumPads?.length) { mapping = mapDrumPads(instruments, rack.drumPads); drumRack = `${rack.name} at ${path}`; break; }
          } catch { /* no rack there */ }
        }
      }
      for (const [instrument, note] of Object.entries(input.notes ?? {})) {
        if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error(`The note for ${instrument} must be 0-127.`);
        mapping[instrument] = { note, pad: null };
      }
      const notes = drumNotes({ style: input.style, bars, swing: input.swing ?? 0, velocity: input.velocity ?? 110, notes: Object.fromEntries(Object.entries(mapping).map(([name, entry]) => [name, entry.note])) });
      return { notes, lengthBeats: bars * 4, summary: { style: input.style, bars, swing: input.swing ?? 0, drumRack, mapping } };
    });
  }
}
