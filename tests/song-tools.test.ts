import { describe, expect, it, vi } from "vitest";
import { keyToRoot, SongTools } from "../src/song-tools.js";

describe("keyToRoot", () => {
  it("takes sharps, flats, and numbers", () => {
    expect(["C", "F#", "Bb", "Eb", "b", 7].map(keyToRoot)).toEqual([0, 6, 10, 3, 11, 7]);
    expect(() => keyToRoot("H")).toThrow(/note name/);
    expect(() => keyToRoot(12)).toThrow(/0 \(C\) to 11/);
  });
});

function fakeLive(ignore: string[] = []) {
  const state = { rootNote: 9, key: "A", scaleName: "Minor", scaleMode: true, scaleIntervals: [0, 2, 3, 5, 7, 8, 10], grooveAmount: 0, loop: { enabled: false, startBeats: 8, lengthBeats: 16 }, punchIn: false, punchOut: false, arrangementOverdub: false, sessionAutomationRecord: true, recordQuantization: 0, canCaptureMidi: false, reEnableAutomationEnabled: false, backToArrangementLit: false };
  const fields: Record<string, (value: unknown) => void> = {
    root_note: v => { state.rootNote = Number(v); state.key = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][Number(v)]; },
    scale_name: v => { state.scaleName = String(v); }, groove_amount: v => { state.grooveAmount = Number(v); },
    loop_start: v => { state.loop.startBeats = Number(v); }, loop_length: v => { state.loop.lengthBeats = Number(v); }, loop: v => { state.loop.enabled = v === true; },
    punch_in: v => { state.punchIn = v === true; }, midi_recording_quantization: v => { state.recordQuantization = Number(v); }
  };
  const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
  return {
    state,
    send: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      if (address === "/live/song_settings/set") for (let k = 0; k < args.length; k += 2) if (!ignore.includes(String(args[k]))) fields[String(args[k])]?.(args[k + 1]);
    }),
    query: vi.fn(async () => ({ args: [JSON.stringify(state)] }))
  };
}

const logger = { write: vi.fn() };

describe("song settings", () => {
  it("sets key, scale, groove, loop, and record quantization in one command and reads them back", async () => {
    const live = fakeLive();
    const result = await new SongTools(live as never, logger as never).setSongSettings({ key: "F#", scale: "Dorian", groovePercent: 50, loop: { enabled: true, startBeats: 16, lengthBeats: 32 }, recordQuantization: "1/16" });
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, data: { after: { key: "F#", scaleName: "Dorian", groovePercent: 50, loop: { enabled: true, startBeats: 16, lengthBeats: 32 }, recordQuantization: "1/16" } } });
  });

  it("names the setting Live did not take", async () => {
    const result = await new SongTools(fakeLive(["scale_name"]) as never, logger as never).setSongSettings({ scale: "Nonsense" });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/did not take scale_name.*Scale menu/) } });
  });

  it("refuses an empty request or an out-of-range groove without sending", async () => {
    const live = fakeLive();
    const tools = new SongTools(live as never, logger as never);
    expect(await tools.setSongSettings({})).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at least one setting/) } });
    expect(await tools.setSongSettings({ groovePercent: 200 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/0 to 131/) } });
    expect(live.send).not.toHaveBeenCalled();
  });
});
