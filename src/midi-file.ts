/**
 * A small Standard MIDI File reader and writer for note data. Times are in beats (quarter notes),
 * as Live uses. Written files are format 1 with a tempo/meta track and one note track.
 */

export interface MidiNote { pitch: number; startTime: number; duration: number; velocity: number; channel?: number }
export interface MidiTrack { name: string | null; notes: MidiNote[] }
export interface MidiFileData { ticksPerBeat: number; tempo: number | null; timeSignature: { numerator: number; denominator: number } | null; tracks: MidiTrack[] }

// 960 ticks per beat, common in DAWs: times are kept to within half a tick (about 0.0005 beats).
const DEFAULT_PPQ = 960;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function variableLength(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7)) { buffer <<= 8; buffer |= (value & 0x7f) | 0x80; }
  for (;;) { bytes.push(buffer & 0xff); if (buffer & 0x80) buffer >>= 8; else break; }
  return bytes;
}

function chunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [...Buffer.from(type, "ascii"), (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...data];
}

export function writeMidiFile(options: { notes: readonly MidiNote[]; name?: string; tempo?: number; timeSignature?: { numerator: number; denominator: number }; ticksPerBeat?: number }): Buffer {
  const ppq = options.ticksPerBeat ?? DEFAULT_PPQ;
  const meta: number[] = [];
  if (options.tempo) {
    const micro = Math.round(60_000_000 / options.tempo);
    meta.push(0, 0xff, 0x51, 3, (micro >> 16) & 0xff, (micro >> 8) & 0xff, micro & 0xff);
  }
  if (options.timeSignature) {
    const power = Math.log2(options.timeSignature.denominator);
    if (!Number.isInteger(power)) throw new Error("Time signature denominator must be a power of two.");
    meta.push(0, 0xff, 0x58, 4, options.timeSignature.numerator, power, 24, 8);
  }
  meta.push(0, 0xff, 0x2f, 0);
  // Note events: off before on at the same tick, so repeated notes do not swallow each other.
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
  for (const note of options.notes) {
    const channel = (note.channel ?? 0) & 0x0f;
    const on = Math.round(note.startTime * ppq);
    const off = Math.max(on + 1, Math.round((note.startTime + note.duration) * ppq));
    const velocity = Math.min(127, Math.max(1, Math.round(note.velocity)));
    events.push({ tick: on, order: 1, bytes: [0x90 | channel, note.pitch & 0x7f, velocity] }, { tick: off, order: 0, bytes: [0x80 | channel, note.pitch & 0x7f, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  if (options.name) { const name = [...Buffer.from(options.name, "utf8")]; track.push(0, 0xff, 0x03, ...variableLength(name.length), ...name); }
  let last = 0;
  for (const event of events) { track.push(...variableLength(event.tick - last), ...event.bytes); last = event.tick; }
  track.push(0, 0xff, 0x2f, 0);
  const header = [0, 1, 0, 2, (ppq >> 8) & 0xff, ppq & 0xff];
  return Buffer.from([...chunk("MThd", header), ...chunk("MTrk", meta), ...chunk("MTrk", track)]);
}

export function readMidiFile(bytes: Uint8Array): MidiFileData {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The MIDI file is larger than 8 MB.");
  let position = 0;
  const text = (length: number) => { const value = Buffer.from(bytes.subarray(position, position + length)).toString("latin1"); position += length; return value; };
  const u32 = () => { const value = (bytes[position] << 24 | bytes[position + 1] << 16 | bytes[position + 2] << 8 | bytes[position + 3]) >>> 0; position += 4; return value; };
  const u16 = () => { const value = bytes[position] << 8 | bytes[position + 1]; position += 2; return value; };
  if (text(4) !== "MThd") throw new Error("This is not a Standard MIDI File (no MThd header).");
  const headerLength = u32();
  const format = u16(); const trackCount = u16(); const division = u16();
  position += headerLength - 6;
  if (format > 1) throw new Error("Only MIDI file formats 0 and 1 are supported.");
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported.");
  const ppq = division;
  let tempo: number | null = null;
  let timeSignature: MidiFileData["timeSignature"] = null;
  const tracks: MidiTrack[] = [];
  for (let t = 0; t < trackCount && position < bytes.length; t++) {
    if (text(4) !== "MTrk") throw new Error(`Track ${t} has no MTrk header.`);
    const trackLength = u32();
    const end = position + trackLength;
    if (end > bytes.length) throw new Error(`Track ${t} runs past the end of the file.`);
    const varLength = () => { let value = 0; for (let k = 0; k < 4; k++) { const byte = bytes[position++]; value = (value << 7) | (byte & 0x7f); if (!(byte & 0x80)) break; } return value; };
    let tick = 0; let status = 0; let name: string | null = null;
    const open = new Map<string, { tick: number; velocity: number }[]>();
    const notes: MidiNote[] = [];
    while (position < end) {
      tick += varLength();
      let byte = bytes[position];
      if (byte & 0x80) { status = byte; position++; } else if (!status) throw new Error(`Track ${t} has data without a status byte.`);
      byte = status;
      if (byte === 0xff) {
        const type = bytes[position++]; const length = varLength(); const data = bytes.subarray(position, position + length); position += length;
        if (type === 0x03 && name === null) name = Buffer.from(data).toString("utf8");
        if (type === 0x51 && tempo === null && length === 3) tempo = Math.round((60_000_000 / (data[0] << 16 | data[1] << 8 | data[2])) * 100) / 100;
        if (type === 0x58 && timeSignature === null && length >= 2) timeSignature = { numerator: data[0], denominator: 2 ** data[1] };
        if (type === 0x2f) break;
        status = 0;
      } else if (byte === 0xf0 || byte === 0xf7) {
        position += varLength(); status = 0;
      } else {
        const kind = byte & 0xf0; const channel = byte & 0x0f;
        const first = bytes[position++]; const second = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[position++];
        const key = `${channel}:${first}`;
        if (kind === 0x90 && second > 0) open.set(key, [...(open.get(key) ?? []), { tick, velocity: second }]);
        else if (kind === 0x80 || (kind === 0x90 && second === 0)) {
          const started = open.get(key)?.shift();
          if (started) notes.push({ pitch: first, startTime: started.tick / ppq, duration: Math.max(1, tick - started.tick) / ppq, velocity: started.velocity, channel });
        }
      }
    }
    position = end;
    notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
    tracks.push({ name, notes });
  }
  return { ticksPerBeat: ppq, tempo, timeSignature, tracks };
}
