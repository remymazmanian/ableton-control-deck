/** Scales, Roman-numeral chords with voice leading, and drum patterns. Times are in beats. */

export interface PlannedNote { pitch: number; startTime: number; duration: number; velocity: number }

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11], "melodic minor": [0, 2, 3, 5, 7, 9, 11]
};

export function scaleSteps(name: string): number[] {
  const steps = SCALES[name.trim().toLowerCase()];
  if (!steps) throw new Error(`Scale '${name}' must be one of: ${Object.keys(SCALES).join(", ")}.`);
  return steps;
}

const NUMERALS = ["vii", "iii", "vi", "iv", "ii", "v", "i"];
const NUMERAL_DEGREE: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

export interface ParsedChord { symbol: string; root: number; intervals: number[] }

/**
 * Parse one Roman numeral against a key (root pitch class) and scale. The root is the scale degree,
 * or, with a leading b or #, the major-scale degree moved by a semitone. Case sets the quality: upper case is major, lower case minor; ° or dim
 * is diminished, + or aug augmented. Suffixes: 7 (dominant on upper case, minor 7th on lower case),
 * maj7, ø7 / m7b5, °7, sus2, sus4, add9.
 */
export function parseNumeral(symbol: string, root: number, scale: number[]): ParsedChord {
  const match = /^([b#♭♯]?)([ivIV]+)(.*)$/.exec(symbol.trim());
  if (!match) throw new Error(`'${symbol}' is not a Roman numeral chord such as I, vi, bVII, or V7.`);
  const [, accidental, numeral, rest] = match;
  const lower = numeral.toLowerCase();
  if (!NUMERALS.includes(lower)) throw new Error(`'${numeral}' is not a numeral from I to VII.`);
  const degree = NUMERAL_DEGREE[lower];
  const shift = accidental === "b" || accidental === "♭" ? -1 : accidental === "#" || accidental === "♯" ? 1 : 0;
  // A plain numeral is the scale's own degree; a flat or sharp is measured from the major scale, as
  // musicians write it, so "bVI" in C minor is A-flat (the same as plain "VI" there).
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const chordRoot = (root + (shift ? MAJOR[degree] + shift : scale[degree]) + 12) % 12;
  const upper = numeral === numeral.toUpperCase();
  const suffix = rest.trim().toLowerCase();
  let intervals: number[];
  if (suffix.startsWith("°7") || suffix.startsWith("dim7")) intervals = [0, 3, 6, 9];
  else if (suffix.startsWith("ø7") || suffix.startsWith("m7b5")) intervals = [0, 3, 6, 10];
  else if (suffix.startsWith("°") || suffix.startsWith("dim")) intervals = [0, 3, 6];
  else if (suffix.startsWith("+") || suffix.startsWith("aug")) intervals = [0, 4, 8];
  else if (suffix.startsWith("sus2")) intervals = [0, 2, 7];
  else if (suffix.startsWith("sus4") || suffix === "sus") intervals = [0, 5, 7];
  else if (suffix.startsWith("maj7")) intervals = upper ? [0, 4, 7, 11] : [0, 3, 7, 11];
  else if (suffix.startsWith("7")) intervals = upper ? [0, 4, 7, 10] : [0, 3, 7, 10];
  else if (suffix === "" || suffix.startsWith("add9")) intervals = upper ? [0, 4, 7] : [0, 3, 7];
  else throw new Error(`Chord suffix '${rest}' in '${symbol}' is not one of: 7, maj7, ø7, °, °7, +, sus2, sus4, add9.`);
  if (suffix.includes("add9")) intervals = [...intervals, 14];
  return { symbol, root: chordRoot, intervals };
}

/** Choose each chord's voicing near the previous one so the voices move as little as possible. */
export function voiceLead(chords: readonly ParsedChord[], centre = 60): number[][] {
  const voicings: number[][] = [];
  let previous: number[] | null = null;
  for (const chord of chords) {
    const candidates: number[][] = [];
    for (let octave = -2; octave <= 2; octave++) {
      const base = chord.intervals.map(step => 12 * Math.floor(centre / 12) + 12 * octave + chord.root + step);
      for (let inversion = 0; inversion < chord.intervals.length; inversion++) {
        const voiced = base.map((pitch, index) => (index < inversion ? pitch + 12 : pitch)).sort((a, b) => a - b);
        if (voiced[0] >= centre - 10 && voiced[voiced.length - 1] <= centre + 16) candidates.push(voiced);
      }
    }
    const cost = (voicing: number[]) => previous
      ? voicing.reduce((sum, pitch) => sum + Math.min(...previous!.map(old => Math.abs(old - pitch))), 0)
      : Math.abs(voicing[0] - (centre - 2));
    candidates.sort((a, b) => cost(a) - cost(b));
    previous = candidates[0];
    voicings.push(previous);
  }
  return voicings;
}

export type ChordRhythm = "sustain" | "stabs" | "offbeats" | "arpeggio";

export function chordNotes(options: { chords: readonly ParsedChord[]; beatsPerChord: number; rhythm: ChordRhythm; bass: boolean; velocity: number; centre?: number }): PlannedNote[] {
  const { chords, beatsPerChord, rhythm, bass, velocity } = options;
  const voicings = voiceLead(chords, options.centre ?? 60);
  const notes: PlannedNote[] = [];
  voicings.forEach((voicing, index) => {
    const start = index * beatsPerChord;
    const hits: Array<[number, number]> =
      rhythm === "sustain" ? [[start, beatsPerChord - 0.05]] :
      rhythm === "stabs" ? Array.from({ length: Math.round(beatsPerChord) }, (_, k) => [start + k, 0.4] as [number, number]) :
      rhythm === "offbeats" ? Array.from({ length: Math.round(beatsPerChord) }, (_, k) => [start + k + 0.5, 0.35] as [number, number]) : [];
    for (const [time, duration] of hits) for (const pitch of voicing) notes.push({ pitch, startTime: time, duration, velocity });
    if (rhythm === "arpeggio") {
      const steps = Math.round(beatsPerChord * 2);
      const order = [...voicing, voicing[0] + 12];
      for (let k = 0; k < steps; k++) notes.push({ pitch: order[k % order.length], startTime: start + k * 0.5, duration: 0.45, velocity: k % 2 ? velocity - 12 : velocity });
    }
    if (bass) {
      const low = 12 * Math.floor((voicing[0] - 12) / 12) + chords[index].root;
      notes.push({ pitch: low >= voicing[0] - 12 ? low - 12 : low, startTime: start, duration: beatsPerChord - 0.05, velocity: Math.min(127, velocity + 6) });
    }
  });
  return notes;
}

export const DRUM_STYLES: Record<string, Record<string, string>> = {
  "four-on-the-floor": { kick: "x...x...x...x...", clap: "....x.......x...", closedHat: "..x...x...x...x." },
  house: { kick: "x...x...x...x...", clap: "....x.......x...", closedHat: "x.x.x.x.x.x.x.x.", openHat: "..x...x...x...x." },
  "boom-bap": { kick: "x......x..x.....", snare: "....x.......x...", closedHat: "x.x.x.x.x.x.x.x." },
  trap: { kick: "x.....x...x.....", snare: "........x.......", closedHat: "xxxxxxxxxxxxxxxx" },
  breakbeat: { kick: "x.x.......xx....", snare: "....x..x.x..x..x", closedHat: "x.x.x.x.x.x.x.x." }
};
export const GM_DRUMS: Record<string, number> = { kick: 36, rim: 37, snare: 38, clap: 39, closedHat: 42, openHat: 46 };
const PAD_WORDS: Record<string, RegExp> = { kick: /kick|bd\b|bass ?drum/i, snare: /snare|sd\b/i, clap: /clap/i, closedHat: /(closed|cl).*hat|hat.*(closed|cl)|^hh|hi.?hat|hat/i, openHat: /open.*hat|hat.*open|^oh/i, rim: /rim/i };

/** Map each instrument to a Drum Rack pad by name, falling back to General MIDI. */
export function mapDrumPads(instruments: readonly string[], pads: ReadonlyArray<{ note: number; name: string }>): Record<string, { note: number; pad: string | null }> {
  const map: Record<string, { note: number; pad: string | null }> = {};
  for (const instrument of instruments) {
    const candidates = pads.filter(pad => PAD_WORDS[instrument]?.test(pad.name));
    // An open hat must not take the closed-hat slot, and the reverse.
    const filtered = instrument === "closedHat" ? candidates.filter(pad => !/open/i.test(pad.name)) : candidates;
    const pad = filtered[0];
    map[instrument] = pad ? { note: pad.note, pad: pad.name } : { note: GM_DRUMS[instrument], pad: null };
  }
  return map;
}

export function drumNotes(options: { style: string; bars: number; swing: number; velocity: number; notes: Record<string, number> }): PlannedNote[] {
  const pattern = DRUM_STYLES[options.style];
  if (!pattern) throw new Error(`style must be one of: ${Object.keys(DRUM_STYLES).join(", ")}.`);
  if (!(options.swing >= 0 && options.swing <= 100)) throw new Error("swing is a percentage from 0 to 100.");
  const swingOffset = (options.swing / 100) * (1 / 12);
  const notes: PlannedNote[] = [];
  for (let bar = 0; bar < options.bars; bar++) {
    for (const [instrument, steps] of Object.entries(pattern)) {
      [...steps].forEach((step, index) => {
        if (step !== "x") return;
        const accent = index % 4 === 0 ? 0 : instrument === "closedHat" ? -(index % 2 ? 30 : 18) : -10;
        const time = bar * 4 + index * 0.25 + (index % 2 ? swingOffset : 0);
        notes.push({ pitch: options.notes[instrument], startTime: Math.round(time * 1000) / 1000, duration: 0.2, velocity: Math.min(127, Math.max(1, options.velocity + accent)) });
      });
    }
  }
  return notes;
}
