import { describe, expect, it, vi } from "vitest";
import { LiveTools } from "../src/live-tools.js";

const logger = { write: vi.fn() };

/** A small stand-in for Live: locators, the playhead, transport and Arrangement clips. */
function fakeLive(state: { cues?: Array<[string, number]>; playhead?: number; playing?: boolean; clips?: Array<[string, number, number, string]>; sessionClipLength?: number } = {}) {
  const live = {
    cues: [...(state.cues ?? [])],
    playhead: state.playhead ?? 0,
    playing: state.playing ?? false,
    clips: [...(state.clips ?? [])],
    sent: [] as string[],
    send: vi.fn(async (address: string, args: unknown[] = []) => {
      live.sent.push(address);
      // Arguments arrive as typed OSC values or, for strings, as plain values.
      const v = args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
      if (address === "/live/song/set/current_song_time") live.playhead = Number(v[0]);
      if (address === "/live/song/create_cue_point" && Math.abs(live.playhead - Number(v[0])) < 0.001) live.cues.push(["", Number(v[0])]);
      if (address === "/live/song/delete_cue_point") live.cues = live.cues.filter(([, t]) => Math.abs(t - Number(v[0])) >= 0.001 || Math.abs(live.playhead - t) >= 0.001);
      if (address === "/live/cue_point/set_name") live.cues = live.cues.map(([n, t]) => [Math.abs(t - Number(v[0])) < 0.001 ? String(v[1]) : n, t]);
      if (address === "/live/track/clear_arrangement") live.clips = [];
      if (address === "/live/track/create_arrangement_midi_clip") {
        const start = Number(v[2]);
        const length = Number(v[3]);
        const end = start + length;
        if (live.clips.some(clip => start < Number(clip[2]) && end > Number(clip[1]))) throw new Error("Clip overlaps");
        live.clips.push([v.length >= 5 ? String(v[4]) : "", start, end, "midi"]);
      }
      if (address === "/live/clip/fill_arrangement") {
        const step = state.sessionClipLength ?? 4;
        for (let p = Number(v[2]); p < Number(v[3]) - 0.0001; p += step) live.clips.push(["Loop", p, p + step, "midi"]);
      }
    }),
    query: vi.fn(async (address: string) => {
      if (address === "/live/song/get/cue_points") return { args: live.cues.flat() };
      if (address === "/live/song/get/current_song_time") return { args: [live.playhead] };
      if (address === "/live/song/get/is_playing") return { args: [live.playing] };
      if (address === "/live/song/get/track_names") return { args: ["Drums", "Bass"] };
      if (address === "/live/track/get/arrangement_clips") return { args: [0, ...live.clips.flat()] };
      return { args: [] };
    })
  };
  return live;
}

describe("locators", () => {
  it("lists locators sorted by position", async () => {
    const live = fakeLive({ cues: [["Drop", 64], ["Intro", 0]] });
    const result = await new LiveTools(live as never, logger as never).listLocators();
    expect(result).toMatchObject({ ok: true, data: { locators: [{ name: "Intro", timeBeats: 0 }, { name: "Drop", timeBeats: 64 }] } });
  });

  it("adds and names a locator, then puts the playhead back", async () => {
    const live = fakeLive({ playhead: 12 });
    const result = await new LiveTools(live as never, logger as never).addLocator(32, "Chorus");
    expect(result).toMatchObject({ ok: true, data: { name: "Chorus", timeBeats: 32 } });
    expect(live.cues).toEqual([["Chorus", 32]]);
    expect(live.playhead).toBe(12);
  });

  it("only renames an existing locator, without moving the playhead", async () => {
    const live = fakeLive({ cues: [["Old", 16]], playhead: 4 });
    const result = await new LiveTools(live as never, logger as never).addLocator(16, "Verse");
    expect(result).toMatchObject({ ok: true, data: { name: "Verse" } });
    expect(live.sent).not.toContain("/live/song/set/current_song_time");
    expect(live.sent).not.toContain("/live/song/create_cue_point");
  });

  it("refuses to add a locator while playing, and sends nothing", async () => {
    const live = fakeLive({ playing: true });
    await expect(new LiveTools(live as never, logger as never).addLocator(8, "Break")).rejects.toThrow(/Stop playback/);
    expect(live.send).not.toHaveBeenCalled();
  });

  it("deletes only the requested locator and puts the playhead back", async () => {
    const live = fakeLive({ cues: [["A", 0], ["B", 16]], playhead: 40 });
    const result = await new LiveTools(live as never, logger as never).deleteLocator(16);
    expect(result).toMatchObject({ ok: true, data: { deletedAtBeats: 16 } });
    expect(live.cues).toEqual([["A", 0]]);
    expect(live.playhead).toBe(40);
  });

  it("reports a missing locator instead of toggling one into existence", async () => {
    const live = fakeLive({ cues: [["A", 0]] });
    await expect(new LiveTools(live as never, logger as never).deleteLocator(8)).rejects.toThrow(/No locator at 8/);
    expect(live.send).not.toHaveBeenCalled();
  });
});

describe("arrangement clips", () => {
  it("lists each clip with its arrangement index and MIDI or audio type", async () => {
    const live = fakeLive({ clips: [["Beat", 0, 4, "midi"], ["Room", 4, 8, "audio"]] });
    const result = await new LiveTools(live as never, logger as never).listArrangementClips(0);
    expect(result).toMatchObject({ ok: true, data: { trackName: "Drums", clips: [
      { index: 0, name: "Beat", startBeats: 0, endBeats: 4, lengthBeats: 4, kind: "midi" },
      { index: 1, name: "Room", startBeats: 4, endBeats: 8, lengthBeats: 4, kind: "audio" }
    ] } });
  });

  it("refuses an arrangement clip reply that has no type", async () => {
    const live = fakeLive();
    live.query.mockResolvedValue({ args: [0, "Beat", 0, 4] });
    const result = await new LiveTools(live as never, logger as never).listArrangementClips(0);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/clip type/) } });
  });

  it("creates an arrangement MIDI clip at start plus length and reads it back", async () => {
    const live = fakeLive();
    const result = await new LiveTools(live as never, logger as never).createArrangementMidiClip({ trackIndex: 0, expectedTrackName: "Drums", startBeats: 8, lengthBeats: 4, name: "Hook" });
    expect(result).toMatchObject({ ok: true, data: { trackName: "Drums", clip: { name: "Hook", startBeats: 8, endBeats: 12, lengthBeats: 4, kind: "midi" } } });
    expect(live.clips).toEqual([["Hook", 8, 12, "midi"]]);
  });

  it("dry-runs the create command after the track name matches", async () => {
    const live = fakeLive();
    const result = await new LiveTools(live as never, logger as never).createArrangementMidiClip({ trackIndex: 0, expectedTrackName: "Drums", startBeats: 8, lengthBeats: 4, name: "Hook", dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, intendedOperations: [{ address: "/live/track/create_arrangement_midi_clip" }] });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("refuses a track name that does not match the index", async () => {
    const live = fakeLive();
    await expect(new LiveTools(live as never, logger as never).createArrangementMidiClip({ trackIndex: 0, expectedTrackName: "Bass", startBeats: 0, lengthBeats: 4 })).rejects.toThrow(/safeguard/);
    expect(live.send).not.toHaveBeenCalled();
  });

  it("reports a Live that has no create_midi_clip instead of claiming success", async () => {
    const live = fakeLive();
    live.send.mockRejectedValue(new Error("Track.create_midi_clip is not available in this Live (12.0.5). It needs Live 12.1.10 or newer."));
    const result = await new LiveTools(live as never, logger as never).createArrangementMidiClip({ trackIndex: 0, expectedTrackName: "Drums", startBeats: 0, lengthBeats: 4 });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/12\.1\.10/) } });
  });

  it("fails when the read-back does not show the new clip", async () => {
    const live = fakeLive();
    live.send.mockResolvedValue(undefined);
    const result = await new LiveTools(live as never, logger as never).createArrangementMidiClip({ trackIndex: 0, expectedTrackName: "Drums", startBeats: 0, lengthBeats: 4, name: "Hook" });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/did not confirm/) } });
  });

  it("tiles a Session clip across a range and reports the copies", async () => {
    const live = fakeLive({ sessionClipLength: 4 });
    const result = await new LiveTools(live as never, logger as never).placeClipInArrangement({ trackIndex: 0, sceneIndex: 1, startBeats: 0, endBeats: 16 });
    expect(result).toMatchObject({ ok: true, data: { copiesInRange: 4, lastEndBeats: 16 } });
  });

  it("rejects a range that ends before it starts", async () => {
    const live = fakeLive();
    await expect(new LiveTools(live as never, logger as never).placeClipInArrangement({ trackIndex: 0, sceneIndex: 0, startBeats: 8, endBeats: 8 })).rejects.toThrow(/endBeats/);
    expect(live.send).not.toHaveBeenCalled();
  });

  it("requires confirm=true to clear a track's Arrangement", async () => {
    const live = fakeLive({ clips: [["Loop", 0, 4, "midi"]] });
    const tools = new LiveTools(live as never, logger as never);
    expect(() => tools.clearArrangementTrack(0, false)).toThrow(/confirm=true/);
    expect(live.send).not.toHaveBeenCalled();
    const result = await tools.clearArrangementTrack(0, true);
    expect(result).toMatchObject({ ok: true, data: { cleared: true } });
    expect(live.clips).toEqual([]);
  });
});
