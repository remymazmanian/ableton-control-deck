import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { SampleIndex } from "../src/sample-index.js";

describe("sample index", () => {
  it("requires explicit confirmation for a rebuild", async () => {
    const index = new SampleIndex("/does/not/matter.json", { write: vi.fn() } as never);
    await expect(index.refresh({ rebuild: true })).rejects.toThrow(/confirm=true/);
  });

  it("indexes and searches metadata without modifying source samples", async () => {
    const root = await mkdtemp(join(tmpdir(), "ableton-samples-"));
    const folder = join(root, "Drum Loops 130 BPM"); await mkdir(folder);
    const sample = join(folder, "House_Kick_128BPM_Cm.wav");
    await writeFile(sample, makeWav(8000, 1));
    const config = join(root, "config.json"); const database = join(root, "index.sqlite");
    await writeFile(config, JSON.stringify({ root, database, favorites: ["Drum Loops 130 BPM/House_Kick_128BPM_Cm.wav"], tags: { "Drum Loops 130 BPM/House_Kick_128BPM_Cm.wav": ["club"] } }));
    const index = new SampleIndex(config, { write: vi.fn() } as never);
    const refreshed = await index.refresh({ rebuild: true, confirm: true });
    expect(refreshed.indexed).toBe(1);
    const result = await index.search({ keywords: "House Kick", bpmMin: 128, bpmMax: 128, favoritesOnly: true, tags: ["club"] });
    expect(result.count).toBe(1);
    expect(result.samples[0]).toMatchObject({ sampleType: "kick", bpm: 128, musicalKey: "Cm", durationSeconds: 1, kind: "loop", favorite: true, tags: ["club"] });
    index.close();
  });
});

function makeWav(sampleRate: number, seconds: number): Buffer {
  const dataSize = sampleRate * seconds * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
