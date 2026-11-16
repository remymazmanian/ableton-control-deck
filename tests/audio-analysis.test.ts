import { describe, expect, it } from "vitest";
import { analyzeAudio, decodeAudio, noteForFrequency } from "../src/audio-analysis.js";

function wav(channels: Float32Array[], rate: number, bits: 16 | 24 | 32, float = false): Buffer {
  const frames = channels[0].length, width = bits / 8, data = Buffer.alloc(frames * channels.length * width);
  for (let i = 0; i < frames; i++) channels.forEach((channel, c) => {
    const at = (i * channels.length + c) * width, v = channel[i];
    if (float) data.writeFloatLE(v, at);
    else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
    else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
    else data.writeInt32LE(Math.round(v * 2147483647), at);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(float ? 3 : 1, 20); header.writeUInt16LE(channels.length, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels.length * width, 28); header.writeUInt16LE(channels.length * width, 32); header.writeUInt16LE(bits, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sine = (hz: number, amplitude: number, seconds: number, rate = 48000) => Float32Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));

describe("audio analysis", () => {
  it("measures a stereo 997 Hz sine at -20 dBFS", () => {
    const tone = sine(997, 0.1, 4);
    const result = analyzeAudio(decodeAudio(wav([tone, tone], 48000, 24)));
    expect(result.samplePeakDbfs).toBeCloseTo(-20, 0);
    expect(result.integratedLufs!).toBeGreaterThan(-20.6);
    expect(result.integratedLufs!).toBeLessThan(-19.4);
    expect(result.stereo?.correlation).toBeCloseTo(1, 2);
    expect(result.stereo!.sideToMidDb!).toBeLessThan(-60);
    const peak = result.spectrum!.peaks.reduce((best, p) => ((p.db ?? -99) > (best.db ?? -99) ? p : best));
    expect(Math.abs(peak.hz - 997)).toBeLessThan(2);
    expect(result.spectrum!.octaveBandsDb.find(band => band.hz === 1000)?.db).toBe(0);
  });

  it("reads float WAV, finds width in a wide signal, and flags silence", () => {
    const left = sine(220, 0.5, 1), right = sine(220, -0.5, 1);
    const wide = analyzeAudio(decodeAudio(wav([left, right], 48000, 32, true)));
    expect(wide.stereo?.correlation).toBeCloseTo(-1, 2);
    expect(wide.spectrum!.peaks.some(p => p.note === "A3")).toBe(true);
    const silent = analyzeAudio(decodeAudio(wav([new Float32Array(4800)], 48000, 16)));
    expect(silent.silent).toBe(true);
    expect(silent.stereo).toBeNull();
  });

  it("names notes and refuses other formats", () => {
    expect(noteForFrequency(440)).toEqual({ note: "A4", cents: 0 });
    expect(() => decodeAudio(Buffer.from("OggS0000"))).toThrow(/WAV and AIFF/);
  });
});
