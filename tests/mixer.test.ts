import { describe, expect, it } from "vitest";
import { dbToLiveVolume, liveVolumeToDb, parseTrackMixerReply, reportedVolumeDb, resolveSend, type MixerSend } from "../src/mixer.js";

const send = (overrides: Partial<MixerSend>): MixerSend => ({
  index: 0, name: "A-Return", returnName: "Delay", level: 0, minimum: 0, maximum: 1, displayValue: "-inf dB", ...overrides
});

describe("Live volume dB mapping", () => {
  it("hits the fader anchors", () => {
    expect(dbToLiveVolume(6)).toBe(1);
    expect(dbToLiveVolume(0)).toBeCloseTo(0.85, 10);
    expect(dbToLiveVolume(-6)).toBeCloseTo(0.7, 10);
    expect(dbToLiveVolume(-18)).toBeCloseTo(0.4, 10);
    expect(dbToLiveVolume(-70)).toBe(0);
    expect(liveVolumeToDb(0.85)).toBeCloseTo(0, 10);
    expect(liveVolumeToDb(1)).toBeCloseTo(6, 10);
    expect(liveVolumeToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(reportedVolumeDb(0)).toBeNull();
    expect(reportedVolumeDb(0.7)).toBe(-6);
  });

  it("round-trips dB values across the three pieces of the curve", () => {
    for (const db of [6, 0, -6, -12, -18, -24, -30, -41, -50, -60, -69]) {
      const back = liveVolumeToDb(dbToLiveVolume(db));
      expect(Math.abs(back - db)).toBeLessThan(0.05);
    }
  });

  it("refuses volume outside -70 dB to +6 dB", () => {
    expect(() => dbToLiveVolume(6.01)).toThrow(/-70 dB to \+6 dB/);
    expect(() => dbToLiveVolume(-70.01)).toThrow(/-70 dB to \+6 dB/);
    expect(() => dbToLiveVolume(Number.NaN)).toThrow(/finite/);
  });
});

describe("mixer reply parsing", () => {
  it("reads master-less track fields and sends, and refuses a short reply", () => {
    const mixer = parseTrackMixerReply([
      1, 0.85, "0.0 dB", 0, "C", 0, 1,
      0, "A-Return", "Delay", 0.25, 0, 1, "-12.0 dB"
    ], "Bass");
    expect(mixer).toMatchObject({
      index: 1, name: "Bass", volume: 0.85, db: 0, pan: 0, muted: false, soloed: true,
      sends: [{ index: 0, name: "A-Return", returnName: "Delay", level: 0.25, displayValue: "-12.0 dB" }]
    });
    expect(() => parseTrackMixerReply([1, 0.85], "Bass")).toThrow(/truncated/);
  });

  it("resolves a send by index or by return name, and refuses ambiguity", () => {
    const sends = [send({ index: 0 }), send({ index: 1, name: "B-Return", returnName: "Reverb" })];
    expect(resolveSend(sends, { sendName: "Delay" }).index).toBe(0);
    expect(resolveSend(sends, { sendIndex: 1, sendName: "Reverb" }).name).toBe("B-Return");
    expect(() => resolveSend(sends, { sendIndex: 3 })).toThrow(/does not exist/);
    expect(() => resolveSend(sends, { sendIndex: 0, sendName: "Reverb" })).toThrow(/safeguard/);
    expect(() => resolveSend([send({ index: 0, returnName: "Delay" }), send({ index: 1, name: "Delay", returnName: "Other" })], { sendName: "Delay" })).toThrow(/Multiple sends/);
    expect(() => resolveSend(sends, {})).toThrow(/sendIndex or sendName/);
  });
});
