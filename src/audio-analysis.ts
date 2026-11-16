import { readFile } from "node:fs/promises";

/** Decoded audio: one Float32Array per channel, samples from -1 to 1. */
export interface Audio { sampleRate: number; channels: Float32Array[]; bitDepth: number; format: "wav" | "aiff" }

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const OCTAVE_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FFT_SIZE = 8192;
const MAX_FFT_FRAMES = 400;
const SILENCE_DB = -90;

// ------------------------------------------------------------------ decoding

export function decodeAudio(bytes: Buffer): Audio {
  const tag = bytes.toString("ascii", 0, 4);
  if (tag === "RIFF" || tag === "RF64") return decodeWav(bytes);
  if (tag === "FORM") return decodeAiff(bytes);
  throw new Error("Only WAV and AIFF files can be analyzed.");
}

function decodeWav(bytes: Buffer): Audio {
  if (bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAVE file.");
  let offset = 12;
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    let size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
      if (format === 0xfffe) format = bytes.readUInt16LE(body + 24);
    } else if (id === "data") {
      if (size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      data = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error("The WAV file has no audio data.");
  if (format !== 1 && format !== 3) throw new Error(`WAV format ${format} is not supported (PCM or float only).`);
  return { sampleRate, bitDepth: bits, format: "wav", channels: deinterleave(data, channels, bits, format === 3, true) };
}

function decodeAiff(bytes: Buffer): Audio {
  const kind = bytes.toString("ascii", 8, 12);
  if (kind !== "AIFF" && kind !== "AIFC") throw new Error("Not an AIFF file.");
  let offset = 12;
  let channels = 0, bits = 0, sampleRate = 0, float = false, little = false;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32BE(offset + 4);
    const body = offset + 8;
    if (id === "COMM") {
      channels = bytes.readUInt16BE(body);
      bits = bytes.readUInt16BE(body + 6);
      sampleRate = readExtended(bytes, body + 8);
      if (kind === "AIFC") {
        const compression = bytes.toString("ascii", body + 18, body + 22);
        if (compression === "fl32" || compression === "FL32") float = true;
        else if (compression === "sowt") little = true;
        else if (compression !== "NONE") throw new Error(`AIFF compression '${compression}' is not supported.`);
      }
    } else if (id === "SSND") {
      const skip = bytes.readUInt32BE(body);
      data = bytes.subarray(body + 8 + skip, Math.min(body + size, bytes.length));
    }
    offset = body + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error("The AIFF file has no audio data.");
  return { sampleRate, bitDepth: bits, format: "aiff", channels: deinterleave(data, channels, bits, float, little) };
}

function readExtended(bytes: Buffer, at: number): number {
  const exponent = (bytes.readUInt16BE(at) & 0x7fff) - 16383;
  const mantissa = bytes.readUInt32BE(at + 2) * 2 ** 32 + bytes.readUInt32BE(at + 6);
  return Math.round(mantissa * 2 ** (exponent - 63));
}

function deinterleave(data: Buffer, count: number, bits: number, float: boolean, little: boolean): Float32Array[] {
  const width = bits / 8;
  if (![2, 3, 4].includes(width) || (float && width !== 4)) throw new Error(`${bits}-bit ${float ? "float" : "PCM"} audio is not supported.`);
  const frames = Math.floor(data.length / (width * count));
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < count; channel++) {
      const at = (frame * count + channel) * width;
      let value: number;
      if (float) value = little ? data.readFloatLE(at) : data.readFloatBE(at);
      else if (width === 2) value = (little ? data.readInt16LE(at) : data.readInt16BE(at)) / 32768;
      else if (width === 3) value = (little ? data.readIntLE(at, 3) : data.readIntBE(at, 3)) / 8388608;
      else value = (little ? data.readInt32LE(at) : data.readInt32BE(at)) / 2147483648;
      channels[channel][frame] = value;
    }
  }
  return channels;
}

// ------------------------------------------------------------------ helpers

const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const round = (value: number, places = 1) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null);

export function noteForFrequency(hz: number): { note: string; cents: number } {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  return { note: `${NOTE_NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`, cents: Math.round((midi - nearest) * 100) };
}

function biquad(input: Float32Array, b: number[], a: number[]): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** ITU-R BS.1770 K-weighting: a high shelf, then a high pass, for any sample rate. */
function kWeight(channel: Float32Array, rate: number): Float64Array {
  const shelf = (() => {
    const A = 10 ** (3.999843853973347 / 40), w = (2 * Math.PI * 1681.974450955533) / rate, alpha = Math.sin(w) / (2 * 0.7071752369554196), c = Math.cos(w), s = 2 * Math.sqrt(A) * alpha;
    return { b: [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)], a: [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s] };
  })();
  const pass = (() => {
    const w = (2 * Math.PI * 38.13547087602444) / rate, alpha = Math.sin(w) / (2 * 0.5003270373238773), c = Math.cos(w);
    return { b: [(1 + c) / 2, -(1 + c), (1 + c) / 2], a: [1 + alpha, -2 * c, 1 - alpha] };
  })();
  return biquad(Float32Array.from(biquad(channel, shelf.b, shelf.a)), pass.b, pass.a);
}

function loudness(audio: Audio) {
  const rate = audio.sampleRate;
  const weighted = audio.channels.slice(0, 2).map(channel => kWeight(channel, rate));
  const blockPowers = (seconds: number, hopSeconds: number) => {
    const size = Math.round(seconds * rate), hop = Math.round(hopSeconds * rate), powers: number[] = [];
    for (let start = 0; start + size <= weighted[0].length; start += hop) {
      let sum = 0;
      for (const channel of weighted) { let e = 0; for (let i = start; i < start + size; i++) e += channel[i] * channel[i]; sum += e / size; }
      powers.push(sum);
    }
    return powers;
  };
  const toLufs = (power: number) => -0.691 + db(power);
  const momentary = blockPowers(0.4, 0.1);
  const absolute = momentary.filter(power => toLufs(power) > -70);
  let integrated = -Infinity;
  if (absolute.length) {
    const threshold = toLufs(absolute.reduce((sum, p) => sum + p, 0) / absolute.length) - 10;
    const gated = absolute.filter(power => toLufs(power) > threshold);
    if (gated.length) integrated = toLufs(gated.reduce((sum, p) => sum + p, 0) / gated.length);
  }
  const shortTerm = blockPowers(3, 1);
  return {
    integratedLufs: round(integrated),
    maxMomentaryLufs: round(momentary.length ? Math.max(...momentary.map(toLufs)) : -Infinity),
    maxShortTermLufs: round(shortTerm.length ? Math.max(...shortTerm.map(toLufs)) : -Infinity)
  };
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Average power spectrum of one channel (Hann window, half-overlapping frames). */
function powerSpectrum(mono: Float32Array): Float64Array {
  const size = Math.min(FFT_SIZE, 2 ** Math.floor(Math.log2(Math.max(mono.length, 2))));
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const hop = size / 2;
  const starts: number[] = [];
  for (let start = 0; start + size <= mono.length; start += hop) starts.push(start);
  const chosen = starts.length > MAX_FFT_FRAMES ? Array.from({ length: MAX_FFT_FRAMES }, (_, i) => starts[Math.floor((i * starts.length) / MAX_FFT_FRAMES)]) : starts;
  const power = new Float64Array(size / 2 + 1);
  for (const start of chosen) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = mono[start + i] * window[i];
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k < power.length; k++) power[k] /= Math.max(chosen.length, 1);
  return power;
}

/** Measured per channel and summed, so sound that cancels in a mono mix is still seen. */
function spectrum(channels: Float32Array[], rate: number) {
  const spectra = channels.slice(0, 2).map(powerSpectrum);
  const power = spectra[0].map((value, k) => spectra.reduce((sum, one) => sum + one[k], 0) / spectra.length);
  const binHz = rate / ((power.length - 1) * 2);
  const audible = (k: number) => k * binHz >= 20 && k * binHz <= Math.min(20000, rate / 2);
  let total = 0, weighted = 0, logSum = 0, count = 0;
  for (let k = 1; k < power.length; k++) {
    if (!audible(k)) continue;
    total += power[k]; weighted += power[k] * k * binHz; logSum += Math.log(power[k] + 1e-30); count++;
  }
  let cumulative = 0, rolloff = 0;
  for (let k = 1; k < power.length; k++) {
    if (!audible(k)) continue;
    cumulative += power[k];
    if (cumulative >= 0.85 * total) { rolloff = k * binHz; break; }
  }
  const bandPower = OCTAVE_BANDS.map(center => {
    let sum = 0;
    for (let k = 1; k < power.length; k++) { const hz = k * binHz; if (hz >= center / Math.SQRT2 && hz < center * Math.SQRT2) sum += power[k]; }
    return sum;
  });
  const loudestBand = Math.max(...bandPower);
  const octaveBands = OCTAVE_BANDS.map((center, i) => ({ hz: center, db: round(db(bandPower[i]) - db(loudestBand)) }));
  // Peaks: local maxima of the spectrum within 30 dB of the strongest, with the frequency refined between bins.
  const strongest = Math.max(...Array.from(power).filter((_, k) => audible(k)));
  const peaks: Array<{ hz: number; db: number | null; note: string; cents: number }> = [];
  const candidates: number[] = [];
  for (let k = 2; k < power.length - 2; k++) {
    if (audible(k) && power[k] > power[k - 1] && power[k] >= power[k + 1] && power[k] > power[k - 2] && power[k] >= power[k + 2] && db(power[k]) - db(strongest) > -30) candidates.push(k);
  }
  candidates.sort((a, b) => power[b] - power[a]);
  for (const k of candidates.slice(0, 10)) {
    const [l, c, r] = [db(power[k - 1]), db(power[k]), db(power[k + 1])];
    const shift = Number.isFinite(l + c + r) && l - 2 * c + r !== 0 ? (0.5 * (l - r)) / (l - 2 * c + r) : 0;
    const hz = (k + shift) * binHz;
    peaks.push({ hz: round(hz, 1) as number, db: round(c - db(strongest)), ...noteForFrequency(hz) });
  }
  peaks.sort((a, b) => a.hz - b.hz);
  return {
    centroidHz: round(total > 0 ? weighted / total : 0, 0),
    rolloff85Hz: round(rolloff, 0),
    flatness: round(total > 0 && count ? Math.exp(logSum / count) / (total / count) : 0, 3),
    octaveBandsDb: octaveBands,
    peaks,
    resolutionHz: round(binHz, 2)
  };
}

function envelope(channels: Float32Array[], rate: number) {
  const window = Math.max(1, Math.round(rate * 0.01));
  const used = channels.slice(0, 2);
  const levels: number[] = [];
  for (let start = 0; start + window <= used[0].length; start += window) {
    let sum = 0;
    for (const channel of used) for (let i = start; i < start + window; i++) sum += channel[i] * channel[i];
    levels.push(sum / (window * used.length));
  }
  const loudest = Math.max(0, ...levels);
  const onset = levels.findIndex(level => db(level) > -60);
  const reach = levels.findIndex(level => level >= loudest * 0.5);
  const segments = Math.min(32, Math.max(1, levels.length));
  const per = levels.length / segments;
  const shape = Array.from({ length: segments }, (_, i) => {
    const slice = levels.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
    return round(db(slice.reduce((sum, level) => sum + level, 0) / Math.max(slice.length, 1)));
  });
  return { attackMs: onset >= 0 && reach >= onset ? (reach - onset) * 10 : null, segmentSeconds: round((per * window) / rate, 3), rmsDbOverTime: shape };
}

// ------------------------------------------------------------------ analysis

export function analyzeAudio(audio: Audio) {
  const [left, right = left] = audio.channels;
  const frames = left.length;
  if (!frames) throw new Error("The file has no samples.");
  let peak = 0, sumL = 0, sumR = 0, sumLR = 0, dc = 0;
  for (let i = 0; i < frames; i++) {
    const l = left[i], r = right[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sumL += l * l; sumR += r * r; sumLR += l * r; dc += l + r;
  }
  const meanSquare = (sumL + sumR) / (2 * frames);
  const peakDb = 20 * Math.log10(peak || 1e-12);
  const silent = peakDb < SILENCE_DB;
  let sumMid = 0, sumSide = 0;
  for (let i = 0; i < frames; i++) { const m = (left[i] + right[i]) / 2, s = (left[i] - right[i]) / 2; sumMid += m * m; sumSide += s * s; }
  const stereo = audio.channels.length < 2 ? null : {
    correlation: round(sumL > 0 && sumR > 0 ? sumLR / Math.sqrt(sumL * sumR) : 1, 3),
    sideToMidDb: round(Math.max(-120, Math.min(120, db(sumSide) - db(sumMid)))),
    balanceDb: round(db(sumL) - db(sumR)),
  };
  return {
    seconds: round(frames / audio.sampleRate, 3),
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    bitDepth: audio.bitDepth,
    silent,
    samplePeakDbfs: round(peakDb),
    rmsDbfs: round(db(meanSquare)),
    crestDb: round(peakDb - db(meanSquare)),
    dcOffset: round(dc / (2 * frames), 5),
    ...loudness(audio),
    stereo,
    spectrum: silent ? null : spectrum(audio.channels, audio.sampleRate),
    envelope: silent ? null : envelope(audio.channels, audio.sampleRate),
  };
}

export async function analyzeAudioFile(path: string) {
  return analyzeAudio(decodeAudio(await readFile(path)));
}
