import { describe, expect, it, vi } from "vitest";
import { findIssues, meterToDb, MeterTools, parseMeters, summarize, type MeterRow } from "../src/meter-tools.js";

describe("meter scale", () => {
  it("matches the Live 12.4.16 calibration within one meter step", () => {
    // Meter readings measured with 1 kHz sine tones at known levels.
    for (const [meter, db] of [[0.921, 0], [0.842, -6], [0.7631, -12], [0.6842, -18], [0.6053, -24], [0.4474, -36]] as const) {
      expect(Math.abs(meterToDb(meter) - db)).toBeLessThanOrEqual(0.75);
    }
    expect(meterToDb(0)).toBe(-Infinity);
    expect(meterToDb(1)).toBeCloseTo(6, 0);
  });

  it("parses the bridge reply", () => {
    const parsed = parseMeters([true, 2, "track", 0, "Drums", 0.84, 0.7631, 0.9, false, true, "master", 0, "Main", 0.921, 0.921, 0.921, false, true]);
    expect(parsed.isPlaying).toBe(true);
    expect(parsed.rows[0]).toEqual({ trackKind: "track", trackIndex: 0, name: "Drums", left: 0.84, right: 0.7631, mute: false, hasAudioOutput: true });
    expect(() => parseMeters([true, 2, "track"])).toThrow(/wrong length/);
  });
});

const row = (name: string, left: number, right = left, extra: Partial<MeterRow> = {}): MeterRow =>
  ({ trackKind: "track", trackIndex: 0, name, left, right, mute: false, hasAudioOutput: true, ...extra });

describe("mix check rules", () => {
  it("summarizes peak, average, and silent share over samples", () => {
    const [drums] = summarize([{ rows: [row("Drums", 0.842)] }, { rows: [row("Drums", 0.921)] }, { rows: [row("Drums", 0)] }]);
    expect(drums.peakDb).toBe(0);
    expect(drums.averageDb).toBeCloseTo(-3, 0);
    expect(drums.silentShare).toBe(0.33);
  });

  it("flags clipping, low headroom, a silent playing track, a lopsided track, and a buried track", () => {
    const levels = summarize([{ rows: [
      row("Lead", 0.97),
      row("Pad", 0.78, 0.78, { trackIndex: 1 }),
      row("Hats", 0.75, 0.55, { trackIndex: 2 }),
      row("Bass", 0, 0, { trackIndex: 3 }),
      row("Vocal Ghost", 0.3, 0.3, { trackIndex: 4 }),
      row("Main", 0.915, 0.915, { trackKind: "master", trackIndex: 0 })
    ] }]);
    const findings = findIssues(levels, new Set(["track:3"]));
    const text = findings.map(f => `${f.severity}: ${f.message}`).join("\n");
    expect(text).toMatch(/problem: 'Lead' peaks at \+3\.7 dB, over 0 dBFS/);
    expect(text).toMatch(/warning: Master peaks at -0\.5 dB, with less than 1 dB of headroom/);
    expect(text).toMatch(/warning: 'Bass' is playing a clip but makes no sound/);
    expect(text).toMatch(/note: 'Hats' leans left/);
    expect(text).toMatch(/note: 'Vocal Ghost' sits \d+ dB below 'Lead'/);
    expect(text).not.toMatch(/'Pad' (peaks|leans|sits)/);
  });

  it("does not flag a muted or stopped silent track", () => {
    const levels = summarize([{ rows: [row("Muted", 0, 0, { mute: true }), row("Stopped", 0, 0, { trackIndex: 1 }), row("Main", 0.8, 0.8, { trackKind: "master" })] }]);
    expect(findIssues(levels, new Set(["track:0"]))).toEqual([]);
  });
});

describe("get_meters", () => {
  it("reports silence as null with a readable value", async () => {
    const live = { send: vi.fn(), query: vi.fn().mockResolvedValue({ args: [true, 2, "track", 0, "Pad", 0, 0, 0, false, true, "track", 1, "Lead", 0.921, 0.842, 0.95, false, true] }) };
    const result = await new MeterTools(live as never, { write: vi.fn() } as never).getMeters();
    expect(result).toMatchObject({ ok: true, data: { tracks: [{ name: "Pad", peakDb: null, peak: "-inf dB" }, { name: "Lead", peakDb: 0, leftDb: 0, rightDb: -6, peak: "0.0 dB" }] } });
  });
});

describe("mix_check", () => {
  it("refuses while Live is stopped", async () => {
    const live = { send: vi.fn(), query: vi.fn().mockResolvedValue({ args: [false, 1, "master", 0, "Main", 0, 0, 0, false, true] }) };
    const result = await new MeterTools(live as never, { write: vi.fn() } as never).mixCheck({ seconds: 1 });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Live is stopped/) } });
  });

  it("samples for the requested time and reports findings", async () => {
    const meters = { args: [true, 2, "track", 0, "Lead", 0.97, 0.97, 1, false, true, "master", 0, "Main", 0.9, 0.9, 0.9, false, true] };
    const playback = { args: [1, "Lead", 0, -1, 1, false] };
    const live = { send: vi.fn(), query: vi.fn(async (address: string) => (address === "/live/meters/get" ? meters : playback)) };
    const result = await new MeterTools(live as never, { write: vi.fn() } as never).mixCheck({ seconds: 1 });
    expect(result).toMatchObject({ ok: true, data: { summary: "1 problem(s), 0 warning(s), 0 note(s).", findings: [{ severity: "problem", track: "Lead" }] } });
    expect((result.data as { samples: number }).samples).toBeGreaterThan(5);
  });
});
