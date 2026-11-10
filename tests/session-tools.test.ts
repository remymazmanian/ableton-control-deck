import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanName, colorToHex, hexToColor, parseDb, parseMixer, parsePlayback, parseRoutingOptions, parseScenes, SessionTools } from "../src/session-tools.js";

const logger = { write: vi.fn() };
const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));

interface FakeState {
  tracks: Array<{ name: string; volume: number; pan: number; mute: boolean; solo: boolean; arm: boolean; send: number; playing: number; fired: number; color: number; output: string; slots: Array<{ name: string; triggered: boolean; playing: boolean; props: Record<string, unknown> } | null> }>;
  scenes: Array<{ name: string; color: number; tempo: number; tempoOn: boolean; triggered: boolean }>;
  canUndo: boolean;
  canRedo: boolean;
  /** When set, the next mutation is accepted but changes nothing. */
  ignoreWrites?: boolean;
  oldScript?: boolean;
  returns: string[];
  /** Notes in the clip at track 0, scene 0: pitch, start, duration, velocity, mute, id. */
  notes: Array<[number, number, number, number, boolean, number]>;
  /** Arrangement clips on track 1 (Bass): name, start, end. */
  arrangement: Array<[string, number, number]>;
  /** Simulates Live trimming an overlapped clip when a sample is loaded. */
  sampleLength: number;
  simplerFile: string | null;
  /** Devices on track 0 (Drums): name, enabled (null when a device has no switch). */
  devices: Array<[string, boolean | null]>;
  selection: [string | null, number, string | null, number, string | null, boolean, string | null];
}

const db = (value: number) => (value <= 0 ? "-inf dB" : `${((value - 0.85) * 40).toFixed(1)} dB`);
const valueForDb = (decibels: number | string) => (decibels === "-inf" ? 0 : Number(decibels) / 40 + 0.85);

// Live snaps colors to its palette; #34C759 became #539F31 in Live 12.4.16.
const snap = (color: number) => (color === 0x34c759 ? 0x539f31 : color);

function fakeLive(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    tracks: [
      { name: "Drums", volume: 0.85, pan: 0, mute: false, solo: false, arm: false, send: 0, playing: -1, fired: -1, color: 0, output: "Main", slots: [{ name: "Beat", triggered: false, playing: false, props: { name: "Beat", looping: true, loop_start: 0, loop_end: 4, launch_mode: 0 } }, null] },
      { name: "Bass", volume: 0.85, pan: 0, mute: false, solo: false, arm: false, send: 0, playing: -1, fired: -1, color: 0, output: "Main", slots: [null, null] }
    ],
    scenes: [{ name: "Intro", color: 0, tempo: 120, tempoOn: false, triggered: false }, { name: "", color: 0, tempo: 120, tempoOn: false, triggered: false }],
    canUndo: true,
    canRedo: false,
    returns: ["A-Reverb"],
    notes: [[36, 0, 0.5, 100, false, 1], [38, 1, 0.5, 100, false, 2], [42, 1.5, 0.25, 80, false, 3]],
    arrangement: [["Verse", 16, 32]],
    sampleLength: 4,
    simplerFile: "/old.wav",
    devices: [["EQ Eight", true], ["Compressor", true]],
    selection: ["track", 0, "Drums", 0, "Intro", true, "Beat"],
    ...overrides
  };
  const sent: Array<{ address: string; args: unknown[] }> = [];
  const undoStack: Array<() => void> = [];
  const mixerReply = (index: number) => {
    const track = state.tracks[index];
    return ["track", index, track.name, "volume", track.volume, "volumeDisplay", db(track.volume), "panning", track.pan, "panningDisplay", "C",
      "mute", track.mute, "solo", track.solo, "canBeArmed", true, "arm", track.arm, "sendCount", 1, "send", 0, track.send, db(track.send), "A-Reverb"];
  };
  const client = {
    state,
    sent,
    send: vi.fn(async (address: string, rawArgs: unknown[] = []) => {
      const args = plain(rawArgs);
      sent.push({ address, args });
      if (state.ignoreWrites) return;
      if (address === "/live/mixer/set") {
        const track = state.tracks[Number(args[1])];
        for (let offset = 3; offset < args.length; offset += 3) {
          const [field, , value] = args.slice(offset, offset + 3);
          if (field === "volume_db") track.volume = valueForDb(value as number);
          if (field === "send_db") track.send = valueForDb(value as number);
          if (field === "panning") track.pan = Number(value);
          if (field === "mute") track.mute = value === true;
          if (field === "solo") track.solo = value === true;
          if (field === "arm") track.arm = value === true;
        }
      }
      if (address === "/live/clip_slot/fire") {
        const slot = state.tracks[Number(args[0])].slots[Number(args[1])];
        if (slot) slot.triggered = true;
      }
      if (address === "/live/clip/set") {
        const slot = state.tracks[Number(args[0])].slots[Number(args[1])]!;
        for (let offset = 4; offset < args.length; offset += 2) slot.props[String(args[offset])] = args[offset] === "color" ? snap(Number(args[offset + 1])) : args[offset + 1];
        slot.name = String(slot.props.name);
      }
      if (address === "/live/clip_slot/load_sample") {
        const name = args.length > 4 ? String(args[4]) : String(args[3]).split("/").pop()!.replace(/\.[^.]+$/, "");
        state.tracks[Number(args[0])].slots[Number(args[1])] = { name, triggered: false, playing: false, props: { name, file_path: args[3] } };
      }
      if (address === "/live/track/load_sample_to_arrangement") {
        const start = Number(args[3]), end = start + state.sampleLength;
        // Live trims a clip the sample overlaps, and deletes one it covers completely.
        state.arrangement = state.arrangement.filter(([, from, to]) => !(from >= start && to <= end)).map(([name, from, to]) => [name, from < end && from >= start ? end : from, to] as [string, number, number]);
        state.arrangement.push([String(args[2]).split("/").pop()!, start, end]);
        undoStack.push(() => { state.arrangement = [["Verse", 16, 32]]; });
      }
      if (address === "/live/song/undo") undoStack.pop()?.();
      if (address === "/live/view/select") {
        if (args[0] !== null) state.selection.splice(0, 3, String(args[0]), Number(args[1]), String(args[2]));
        if (Number(args[3]) >= 0) state.selection.splice(3, 2, Number(args[3]), state.scenes[Number(args[3])].name);
      }
      if (address === "/live/device/set_enabled") state.devices[Number(args[3])][1] = args[5] === true;
      if (address === "/live/device/delete") state.devices.splice(Number(args[3]), 1);
      if (address === "/live/device/replace_sample") state.simplerFile = String(args[4]);
      if (address === "/live/song/delete_scene") state.scenes.splice(Number(args[0]), 1);
      // Live reads a return track's name back with its letter, such as "B-Plate".
      if (address === "/live/song/create_return_track") state.returns.push(`${String.fromCharCode(65 + state.returns.length)}-${args.length ? String(args[0]) : "Return"}`);
      if (address === "/live/song/delete_return_track") state.returns.splice(Number(args[0]), 1);
      if (address === "/live/session_clip/modify/notes") {
        for (let offset = 4; offset < args.length; offset += 6) {
          const note = state.notes.find(entry => entry[5] === args[offset])!;
          note.splice(0, 5, Number(args[offset + 1]), Number(args[offset + 2]), Number(args[offset + 3]), Number(args[offset + 4]), args[offset + 5] === true);
        }
      }
      if (address === "/live/session_clip/remove/notes") {
        const [fromPitch, pitchSpan, fromTime, timeSpan] = args.slice(4).map(Number);
        state.notes = state.notes.filter(([pitch, start]) => !(pitch >= fromPitch && pitch < fromPitch + pitchSpan && start >= fromTime && start < fromTime + timeSpan));
      }
      if (address === "/live/song/undo") { state.canRedo = true; }
      if (address === "/live/track/set") {
        for (let offset = 3; offset < args.length; offset += 2) {
          if (args[offset] === "output_routing_type") state.tracks[Number(args[1])].output = String(args[offset + 1]);
          if (args[offset] === "color") state.tracks[Number(args[1])].color = snap(Number(args[offset + 1]));
        }
      }
    }),
    query: vi.fn(async (address: string, rawArgs: unknown[] = []) => {
      const args = plain(rawArgs);
      if (address === "/live/song/get/track_names") return { args: state.tracks.map(track => track.name) };
      if (address === "/live/mixer/get") {
        if (args[0] === "return" && Number(args[1]) >= state.returns.length) throw new Error(`Return track index ${args[1]} does not exist`);
        if (args[0] === "master") return { args: ["master", 0, "Main", "volume", 0.85, "volumeDisplay", "0.0 dB", "panning", 0, "panningDisplay", "C", "canBeArmed", false, "sendCount", 0] };
        if (args[0] === "return") return { args: ["return", args[1], state.returns[Number(args[1])], "volume", 0.85, "volumeDisplay", "0.0 dB", "panning", 0, "panningDisplay", "C", "mute", false, "solo", false, "canBeArmed", false, "sendCount", 0] };
        return { args: mixerReply(Number(args[1])) };
      }
      if (address === "/live/clip_slot/get/state") {
        const slot = state.tracks[Number(args[0])].slots[Number(args[1])];
        return { args: [args[0], args[1], slot !== null, slot?.name ?? null, slot?.playing ?? false, slot?.triggered ?? false, false] };
      }
      if (address === "/live/clip/get/properties") {
        const slot = state.tracks[Number(args[0])].slots[Number(args[1])]!;
        return { args: [args[0], args[1], "file_path" in slot.props ? "audio" : "midi", ...Object.entries(slot.props).flat()] };
      }
      if (address === "/live/song/get/scenes") {
        if (state.oldScript) throw new Error("Unsupported song query: /live/song/get/scenes");
        return { args: [state.scenes.length, ...state.scenes.flatMap(scene => [scene.name, scene.color, scene.tempo, scene.tempoOn, 4, 4, false, scene.triggered])] };
      }
      if (address === "/live/song/get/scenes/name") return { args: state.scenes.map(scene => scene.name) };
      if (address === "/live/session/get/playback") return { args: [state.tracks.length, ...state.tracks.flatMap(track => [track.name, track.playing, track.fired]), state.scenes.length, ...state.scenes.map(scene => scene.triggered)] };
      if (address === "/live/track/get/arrangement_clips") return { args: [args[0], ...(Number(args[0]) === 1 ? state.arrangement.flatMap(([name, start, end]) => [name, start, end, "audio"]) : [])] };
      if (address === "/live/view/get/selection") return { args: [...state.selection] };
      if (address === "/live/devices/get/state") return { args: [args[0], args[1], "Drums", state.devices.length, ...state.devices.flatMap(([name, enabled]) => [name, "Eq8", enabled])] };
      if (address === "/live/track/get/devices/name") return { args: [args[0], "EQ Eight", "Simpler"] };
      if (address === "/live/device/get/sample") return { args: [args[0], args[2], "Simpler", state.simplerFile] };
      if (address === "/live/session_clip/get/notes") return { args: [args[0], args[1], "Beat", ...state.notes.flat()] };
      if (address === "/live/song/get/undo_state") return { args: [state.canUndo, state.canRedo] };
      if (address === "/live/track/get/details") {
        const track = state.tracks[Number(args[1])];
        return { args: ["track", args[1], track.name, "color", track.color, "folded", null, "input_routing_type", "All Ins", "input_routing_channel", "All Channels", "output_routing_type", track.output, "output_routing_channel", "Track In"] };
      }
      throw new Error(`Unexpected query ${address}`);
    })
  };
  return client;
}

describe("session reply parsers", () => {
  it("parses dB displays, colors, and mixer replies", () => {
    expect(parseDb("-6.0 dB")).toBe(-6);
    expect(parseDb("-inf dB")).toBe(-Infinity);
    expect(parseDb("C")).toBeNull();
    expect(hexToColor("#ff8800")).toBe(0xff8800);
    expect(colorToHex(0xff8800)).toBe("#FF8800");
    expect(() => hexToColor("orange")).toThrow(/hex RGB/);
    const mixer = parseMixer(["track", 0, "Drums", "volume", 0.7, "volumeDisplay", "-6.0 dB", "panning", 0, "panningDisplay", "C", "mute", false, "solo", true, "canBeArmed", false, "sendCount", 1, "send", 0, 0, "-inf dB", "A-Reverb"]);
    expect(mixer).toMatchObject({ name: "Drums", volumeDb: -6, solo: true, arm: null, sends: [{ index: 0, db: -Infinity, returnName: "A-Reverb" }] });
  });

  it("parses scenes, playback, and routing options", () => {
    expect(parseScenes([1, "Drop", 0xff0000, 128, true, 7, 8, true, false])).toEqual([{ index: 0, name: "Drop", color: "#FF0000", tempo: 128, timeSignature: { numerator: 7, denominator: 8 }, triggered: false }]);
    expect(() => parseScenes([2, "Drop"])).toThrow(/wrong length/);
    const playback = parsePlayback([3, "A", 0, -1, "B", 0, -2, "C", -1, 1, 2, false, true]);
    expect(playback.tracks.map(track => track.state)).toEqual(["playing", "stopping", "queued"]);
    expect(playback.triggeredScenes).toEqual([1]);
    // -2 after a stop means Live's stop button fired; report it as no clip.
    expect(parsePlayback([1, "A", -2, -1, 0]).tracks[0]).toMatchObject({ playingSlotIndex: -1, state: "stopped" });
    // Live 11 has no tempo_enabled; an unset tempo or signature reads -1.
    expect(parseScenes([2, "Set", 0, 128, null, 7, 8, null, false, "Unset", 0, -1, null, -1, -1, null, false]).map(scene => [scene.tempo, scene.timeSignature])).toEqual([[128, { numerator: 7, denominator: 8 }], [null, null]]);
    expect(cleanName(" A\nB\x00 ")).toBe("A B");
    expect(parseRoutingOptions(["track", 0, "Drums", "input_routing_type", 2, "All Ins", "No Input", "output_routing_type", 1, "Main"])).toEqual({ input_routing_type: ["All Ins", "No Input"], output_routing_type: ["Main"] });
  });
});

describe("mixer", () => {
  it("sends every change in one command and reads the mix back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", volumeDb: -6, pan: -0.25, mute: true, sends: [{ sendIndex: 0, db: -12 }] });
    expect(result.ok).toBe(true);
    expect(live.sent).toEqual([{ address: "/live/mixer/set", args: ["track", 0, "Drums", "volume_db", -1, -6, "panning", -1, -0.25, "mute", -1, true, "send_db", 0, -12] }]);
    expect(result.data).toMatchObject({ before: { volumeDb: 0 }, after: { volumeDb: -6, mute: true, sends: [{ db: -12 }] } });
  });

  it("fails when Live does not show the requested value", async () => {
    const live = fakeLive({ ignoreWrites: true });
    const result = await new SessionTools(live as never, logger as never).setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", volumeDb: -6 });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Volume reads 0.0 dB, not -6 dB/) } });
  });

  it("refuses a stale track name or an empty change without sending", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Kick", mute: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'Drums'/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Drums" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Nothing to change/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", volume: 0.5, volumeDb: -3 })).toMatchObject({ ok: false });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("makes a dry run report what the real call would refuse", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    const dry = { dryRun: true };
    expect(await tools.setTrackMix({ trackIndex: 0, trackKind: "master", expectedTrackName: "Main", mute: true, ...dry })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/no mute/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", sends: [{ sendIndex: 4, db: -6 }], ...dry })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Send 4 does not exist/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", volumeDb: 9, ...dry })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/above 6 dB/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, trackKind: "return", expectedTrackName: "A-Reverb", sends: [{ sendIndex: 0, db: -6 }], ...dry })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cannot send to itself/) } });
    expect(await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", gain: 0.5, ...dry })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/gain applies only to audio clips/) } });
    expect(await tools.setTrackMix({ trackIndex: 0, expectedTrackName: "Drums", volumeDb: 3, ...dry })).toMatchObject({ ok: true, dryRun: true });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("reads every track, return, and the master", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).getMixer();
    expect(result.data).toMatchObject({ tracks: [{ name: "Drums" }, { name: "Bass" }], returns: [{ name: "A-Reverb" }], master: { name: "Main", mute: null } });
  });
});

describe("launching", () => {
  it("fires a named clip and reports it queued", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).fireClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat" });
    expect(result).toMatchObject({ ok: true, data: { state: "queued", clipName: "Beat" } });
  });

  it("refuses to fire a renamed clip or an empty slot", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.fireClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Fill" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'Beat'/) } });
    expect(await tools.fireClip({ trackIndex: 0, sceneIndex: 1, expectedTrackName: "Drums", expectedClipName: "Beat" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No clip/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed scene launch instead of failing", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).fireScene({ sceneIndex: 1, expectedSceneName: "" });
    expect(result).toMatchObject({ ok: true, data: { confirmed: false, note: expect.stringMatching(/no clips/) } });
  });
});

describe("scenes and clips", () => {
  it("needs confirm to delete a scene, and a dry run sends nothing", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.deleteScene({ sceneIndex: 0, expectedSceneName: "Intro", confirm: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(await tools.deleteScene({ sceneIndex: 0, expectedSceneName: "Intro", confirm: false, dryRun: true })).toMatchObject({ ok: true, dryRun: true, intendedOperations: [{ address: "/live/song/delete_scene" }] });
    expect(live.send).not.toHaveBeenCalled();
    expect(await tools.deleteScene({ sceneIndex: 0, expectedSceneName: "Intro", confirm: true })).toMatchObject({ ok: true, data: { sceneCount: 1 } });
  });

  it("falls back to scene names with an older remote script", async () => {
    const result = await new SessionTools(fakeLive({ oldScript: true }) as never, logger as never).listScenes();
    expect(result).toMatchObject({ ok: true, data: { scenes: [{ index: 0, name: "Intro" }, { index: 1, name: "" }], note: expect.stringMatching(/npm run setup/) } });
  });

  it("sets clip properties by name and reads them back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", name: "Beat B", loopStart: 8, loopEnd: 12, launchMode: "toggle" });
    expect(live.sent[0]).toEqual({ address: "/live/clip/set", args: [0, 0, "Drums", "Beat", "name", "Beat B", "loop_start", 8, "loop_end", 12, "launch_mode", 2] });
    expect(result).toMatchObject({ ok: true, data: { after: { name: "Beat B", loopStart: 8, loopEnd: 12, launchMode: "toggle" } } });
  });

  it("reports when Live snaps a clip or track color to its palette", async () => {
    const tools = new SessionTools(fakeLive() as never, logger as never);
    const clip = await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", color: "#34c759" });
    expect(clip).toMatchObject({ ok: true, data: { after: { color: "#539F31" }, colorSnapped: true } });
    const exact = await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", color: "#ff8800" });
    expect(exact).toMatchObject({ ok: true, data: { colorSnapped: false } });
    const track = await tools.setTrack({ trackIndex: 1, expectedTrackName: "Bass", color: "#34C759" });
    expect(track).toMatchObject({ ok: true, data: { after: { color: "#539F31" }, colorSnapped: true } });
    const noColor = await tools.setTrack({ trackIndex: 1, expectedTrackName: "Bass", outputType: "Main" });
    expect(noColor.ok && "colorSnapped" in (noColor.data as object)).toBe(false);
  });

  it("names settings Live changed on its own, and refuses unknown mode names", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    // Simulate Live turning looping off when a setting changes.
    const send = live.send.getMockImplementation()!;
    live.send.mockImplementationOnce(async (address: string, args: unknown[] = []) => { await send(address, args); if (address === "/live/clip/set") await send("/live/clip/set", [0, 0, "Drums", "Beat", "looping", false]); });
    const result = await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", launchMode: "gate" });
    expect(result).toMatchObject({ ok: true, data: { alsoChangedByLive: ["looping"], note: expect.stringMatching(/looping/) } });
    const quiet = await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", launchMode: "trigger" });
    expect(quiet.ok && "alsoChangedByLive" in (quiet.data as object)).toBe(false);
    const bad = await tools.setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", warpMode: "repitch" as never });
    expect(bad).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Warp mode 'repitch' is not one of: .*re-pitch/) } });
  });

  it("fails a clip change Live did not apply", async () => {
    const result = await new SessionTools(fakeLive({ ignoreWrites: true }) as never, logger as never).setClip({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat", loopEnd: 16 });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/loop_end is 4, not 16/) } });
  });
});

describe("undo and tracks", () => {
  it("undoes with a note that the step may not be Control Deck's", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.undo()).toMatchObject({ ok: true, data: { after: { canRedo: true }, note: expect.stringMatching(/by hand/) } });
    live.state.canRedo = false;
    live.state.canUndo = false;
    expect(await tools.undo()).toMatchObject({ ok: false, error: { message: expect.stringMatching(/nothing to undo/) } });
  });

  it("sets routing by exact name and reads it back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).setTrack({ trackIndex: 1, expectedTrackName: "Bass", outputType: "Sends Only" });
    expect(result).toMatchObject({ ok: true, data: { before: { outputType: "Main" }, after: { outputType: "Sends Only" } } });
  });
});

describe("session clip notes and return tracks", () => {
  const beat = { trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", expectedClipName: "Beat" };

  it("reads notes with ids, sorted by time", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).getClipNotes({ trackIndex: 0, sceneIndex: 0 });
    expect(result).toMatchObject({ ok: true, data: { clipName: "Beat", noteCount: 3, notes: [{ noteId: 1, pitch: 36 }, { noteId: 2, pitch: 38 }, { noteId: 3, pitch: 42 }] } });
  });

  it("modifies notes by id, keeping unspecified fields, and reads them back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).modifyClipNotes({ ...beat, notes: [{ noteId: 2, pitch: "E1", velocity: 90 }] });
    expect(live.sent[0]).toEqual({ address: "/live/session_clip/modify/notes", args: [0, 0, "Drums", "Beat", 2, 40, 1, 0.5, 90, false] });
    expect(result).toMatchObject({ ok: true, data: { noteCountModified: 1, notes: [{ pitch: 36 }, { noteId: 2, pitch: 40, velocity: 90, duration: 0.5 }, { pitch: 42 }] } });
  });

  it("splits a large note edit into datagrams that fit, all for the same clip", async () => {
    const notes = Array.from({ length: 256 }, (_, index) => [60, index * 0.123456789012345, 0.0999999999999, 100, false, index + 1] as [number, number, number, number, boolean, number]);
    const live = fakeLive({ notes });
    const result = await new SessionTools(live as never, logger as never).modifyClipNotes({ ...beat, notes: notes.map(note => ({ noteId: note[5], velocity: 90 })) });
    expect(result.ok).toBe(true);
    expect(live.sent.length).toBeGreaterThan(1);
    expect(live.sent.every(entry => entry.address === "/live/session_clip/modify/notes" && entry.args[3] === "Beat")).toBe(true);
    expect(live.sent.reduce((sum, entry) => sum + (entry.args.length - 4) / 6, 0)).toBe(256);
    expect(live.state.notes.every(note => note[3] === 90)).toBe(true);
  });

  it("refuses an unknown note id or a stale clip name without sending", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.modifyClipNotes({ ...beat, notes: [{ noteId: 9, velocity: 90 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No note with id 9/) } });
    expect(await tools.modifyClipNotes({ ...beat, expectedClipName: "Fill", notes: [{ noteId: 1, velocity: 90 }] })).toMatchObject({ ok: false });
    expect(await tools.removeClipNotes({ ...beat, fromPitch: 60, pitchSpan: 1, fromTime: 0, timeSpan: 4 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No notes start/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("removes notes in a range and reports which ids went", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).removeClipNotes({ ...beat, fromPitch: 38, pitchSpan: 5, fromTime: 1, timeSpan: 1 });
    expect(result).toMatchObject({ ok: true, data: { removedNoteIds: [2, 3], noteCountInClip: 1 } });
  });

  it("creates a named return track and deletes one only with confirm", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.createReturnTrack({ name: "Plate" })).toMatchObject({ ok: true, data: { created: { trackKind: "return", trackIndex: 1, name: "B-Plate" }, returnTracks: ["A-Reverb", "B-Plate"] } });
    expect(await tools.deleteReturnTrack({ trackIndex: 1, expectedTrackName: "B-Plate", confirm: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(await tools.deleteReturnTrack({ trackIndex: 1, expectedTrackName: "B-Delay", confirm: true })).toMatchObject({ ok: false });
    expect(await tools.deleteReturnTrack({ trackIndex: 1, expectedTrackName: "B-Plate", confirm: true })).toMatchObject({ ok: true, data: { returnTracks: ["A-Reverb"] } });
    expect(await tools.createReturnTrack({ dryRun: true })).toMatchObject({ ok: true, dryRun: true });
    expect(live.state.returns).toEqual(["A-Reverb"]);
  });

  it("refuses a 13th return track", async () => {
    const live = fakeLive({ returns: Array.from({ length: 12 }, (_, index) => `R${index}`) });
    expect(await new SessionTools(live as never, logger as never).createReturnTrack({})).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at most 12/) } });
  });
});

describe("sample loading", () => {
  const folder = mkdtempSync(join(tmpdir(), "control-deck-samples-"));
  const kick = join(folder, "Kick 01.wav");
  writeFileSync(kick, "RIFF");
  const text = join(folder, "notes.txt");
  writeFileSync(text, "x");
  const disguised = join(folder, "disguised.wav");
  symlinkSync(text, disguised);
  const realKick = realpathSync(kick);

  it("loads a file into an empty audio slot and reads the clip back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).loadSampleToClipSlot({ trackIndex: 1, sceneIndex: 0, expectedTrackName: "Bass", path: kick, clipName: "Kick" });
    expect(live.sent[0]).toEqual({ address: "/live/clip_slot/load_sample", args: [1, 0, "Bass", realKick, "Kick"] });
    expect(result).toMatchObject({ ok: true, data: { file: realKick, clip: { kind: "audio", name: "Kick" } } });
  });

  it("refuses bad paths, an occupied slot, and a missing sample index without sending", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    const slot = { trackIndex: 1, sceneIndex: 0, expectedTrackName: "Bass" };
    expect(await tools.loadSampleToClipSlot({ ...slot, path: "Kick 01.wav" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/absolute/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, path: text })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/must be one of/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, path: disguised })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not audio/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, path: join(folder, "missing.wav") })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No file/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, path: kick, sampleId: 3 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/exactly one/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, sampleId: 3 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/sample index is not available/) } });
    expect(await tools.loadSampleToClipSlot({ trackIndex: 0, sceneIndex: 0, expectedTrackName: "Drums", path: kick })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/already holds clip 'Beat'/) } });
    expect(await tools.loadSampleToClipSlot({ ...slot, path: kick, clipName: "   " })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/more than spaces/) } });
    expect(await tools.loadSampleToArrangement({ trackIndex: 1, expectedTrackName: "Bass", startBeats: 1e9, path: kick })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/from 0 to 1576800/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("refuses looping an unwarped audio clip unless warping is turned on too", async () => {
    const live = fakeLive();
    live.state.tracks[1].slots[0] = { name: "Take", triggered: false, playing: false, props: { name: "Take", file_path: "/take.wav", warping: false, looping: false } };
    const tools = new SessionTools(live as never, logger as never);
    const take = { trackIndex: 1, sceneIndex: 0, expectedTrackName: "Bass", expectedClipName: "Take" };
    expect(await tools.setClip({ ...take, looping: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/only loops a warped audio clip/) } });
    expect(live.send).not.toHaveBeenCalled();
    expect(await tools.setClip({ ...take, looping: true, warping: true })).toMatchObject({ ok: true });
  });

  it("fails when the new clip plays a different file", async () => {
    const live = fakeLive();
    const send = live.send.getMockImplementation()!;
    live.send.mockImplementationOnce(async (address: string, args: unknown[] = []) => { await send(address, args); live.state.tracks[1].slots[0]!.props.file_path = "/elsewhere.wav"; });
    const result = await new SessionTools(live as never, logger as never).loadSampleToClipSlot({ trackIndex: 1, sceneIndex: 0, expectedTrackName: "Bass", path: kick });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/plays \/elsewhere.wav/) } });
  });

  it("resolves a sample id through the sample index", async () => {
    const live = fakeLive();
    const lookup = vi.fn(async () => kick);
    const result = await new SessionTools(live as never, logger as never, false, lookup).loadSampleToClipSlot({ trackIndex: 1, sceneIndex: 1, expectedTrackName: "Bass", sampleId: 42 });
    expect(lookup).toHaveBeenCalledWith(42);
    expect(result).toMatchObject({ ok: true, data: { file: realKick } });
  });

  it("places a sample in the Arrangement where it fits", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).loadSampleToArrangement({ trackIndex: 1, expectedTrackName: "Bass", startBeats: 4, path: kick });
    expect(result).toMatchObject({ ok: true, data: { clip: { startBeats: 4, endBeats: 8 } } });
  });

  it("undoes a load that trimmed an existing clip, and refuses a start inside one", async () => {
    const live = fakeLive({ sampleLength: 8 });
    const tools = new SessionTools(live as never, logger as never);
    const result = await tools.loadSampleToArrangement({ trackIndex: 1, expectedTrackName: "Bass", startBeats: 12, path: kick });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/overlap clip 'Verse' at beat 16, so the load was undone/) } });
    expect(live.state.arrangement).toEqual([["Verse", 16, 32]]);
    expect(live.sent.map(entry => entry.address)).toEqual(["/live/track/load_sample_to_arrangement", "/live/song/undo"]);
    expect(await tools.loadSampleToArrangement({ trackIndex: 1, expectedTrackName: "Bass", startBeats: 20, path: kick })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/'Verse' already covers beat 20/) } });
  });

  it("undoes a load that deleted a clip it covered completely", async () => {
    const live = fakeLive({ sampleLength: 20 });
    const result = await new SessionTools(live as never, logger as never).loadSampleToArrangement({ trackIndex: 1, expectedTrackName: "Bass", startBeats: 14, path: kick });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/overlap clip 'Verse' at beat 16, so the load was undone/) } });
    expect(live.state.arrangement).toEqual([["Verse", 16, 32]]);
  });

  it("replaces a Simpler sample and reads the new file back", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).replaceSimplerSample({ trackIndex: 0, expectedTrackName: "Drums", deviceIndex: 1, expectedDeviceName: "Simpler", path: kick });
    expect(result).toMatchObject({ ok: true, data: { previousFile: "/old.wav", file: realKick, deviceName: "Simpler" } });
    const again = await new SessionTools(fakeLive({ simplerFile: realKick }) as never, logger as never).replaceSimplerSample({ trackIndex: 0, expectedTrackName: "Drums", deviceIndex: 1, expectedDeviceName: "Simpler", path: kick });
    expect(again).toMatchObject({ ok: false, error: { message: expect.stringMatching(/already plays/) } });
  });
});

describe("devices", () => {
  const eq = { trackIndex: 0, expectedTrackName: "Drums", deviceIndex: 0, expectedDeviceName: "EQ Eight" };

  it("lists devices with their on/off state", async () => {
    const result = await new SessionTools(fakeLive({ devices: [["EQ Eight", true], ["Utility", null]] }) as never, logger as never).getDevices({ trackIndex: 0 });
    expect(result).toMatchObject({ ok: true, data: { trackName: "Drums", devices: [{ deviceIndex: 0, name: "EQ Eight", enabled: true }, { deviceIndex: 1, name: "Utility", enabled: null }] } });
  });

  it("turns a device off and reads it back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).setDeviceEnabled({ ...eq, enabled: false });
    expect(live.sent[0]).toEqual({ address: "/live/device/set_enabled", args: ["track", 0, "Drums", 0, "EQ Eight", false] });
    expect(result).toMatchObject({ ok: true, data: { before: true, enabled: false } });
  });

  it("refuses a stale device name, a missing device, or a device without a switch", async () => {
    const live = fakeLive({ devices: [["EQ Eight", true], ["Utility", null]] });
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.setDeviceEnabled({ ...eq, expectedDeviceName: "Reverb", enabled: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'EQ Eight'/) } });
    expect(await tools.setDeviceEnabled({ ...eq, deviceIndex: 4, enabled: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/has 2 device/) } });
    expect(await tools.setDeviceEnabled({ ...eq, deviceIndex: 1, expectedDeviceName: "Utility", enabled: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/no on\/off switch/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("deletes a device only with confirm and reads the chain back", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.deleteDevice({ ...eq, confirm: false })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(await tools.deleteDevice({ ...eq, confirm: true })).toMatchObject({ ok: true, data: { deleted: { name: "EQ Eight" }, devices: [{ deviceIndex: 0, name: "Compressor" }] } });
  });
});

describe("selection", () => {
  it("reads the selected track, scene, and clip", async () => {
    const result = await new SessionTools(fakeLive() as never, logger as never).getSelection();
    expect(result).toMatchObject({ ok: true, data: { track: { trackKind: "track", trackIndex: 0, name: "Drums" }, scene: { sceneIndex: 0, name: "Intro" }, clip: { name: "Beat" } } });
    const master = await new SessionTools(fakeLive({ selection: ["master", 0, "Main", -1, null, false, null] }) as never, logger as never).getSelection();
    expect(master).toMatchObject({ ok: true, data: { track: { trackKind: "master", name: "Main" }, scene: null, clip: null } });
  });

  it("selects a track and scene by name and reads the selection back", async () => {
    const live = fakeLive();
    const result = await new SessionTools(live as never, logger as never).select({ trackIndex: 1, expectedTrackName: "Bass", sceneIndex: 1, expectedSceneName: "" });
    expect(live.sent[0]).toEqual({ address: "/live/view/select", args: ["track", 1, "Bass", 1, ""] });
    expect(result).toMatchObject({ ok: true, data: { after: { track: { trackIndex: 1, name: "Bass" }, scene: { sceneIndex: 1 } } } });
  });

  it("refuses an empty selection, a missing name, or a stale scene name without sending", async () => {
    const live = fakeLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.select({})).toMatchObject({ ok: false, error: { message: expect.stringMatching(/trackIndex, sceneIndex, or both/) } });
    expect(await tools.select({ trackIndex: 0 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/expectedTrackName is required/) } });
    expect(await tools.select({ sceneIndex: 0, expectedSceneName: "Drop" })).toMatchObject({ ok: false });
    expect(live.send).not.toHaveBeenCalled();
  });
});

describe("application view", () => {
  function viewLive() {
    let state: [string, boolean, boolean, boolean, boolean] = ["session", false, false, false, false];
    return {
      sent: [] as unknown[][],
      send: vi.fn(async function (this: unknown, address: string, raw: unknown[] = []) {
        const [view, detail, browser] = raw as [string | null, string | null, boolean | null];
        if (view) state[0] = view;
        if (detail === "hide") state = [state[0], false, false, false, state[4]];
        else if (detail) state = [state[0], true, detail === "clip", detail === "devices", state[4]];
        if (browser !== null) state[4] = browser;
      }),
      query: vi.fn(async () => ({ args: [...state] }))
    };
  }

  it("switches to the Arrangement with the clip editor and reads it back", async () => {
    const live = viewLive();
    const result = await new SessionTools(live as never, logger as never).showView({ view: "arrangement", detail: "clip" });
    expect(live.send).toHaveBeenCalledWith("/live/app_view/show", ["arrangement", "clip", null]);
    expect(result).toMatchObject({ ok: true, data: { before: { main: "session" }, after: { main: "arrangement", detail: true, clipEditor: true } } });
  });

  it("refuses an empty request and fails when Live does not switch", async () => {
    const live = viewLive();
    const tools = new SessionTools(live as never, logger as never);
    expect(await tools.showView({})).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Pass view, detail, browser/) } });
    live.send.mockImplementation(async () => undefined);
    expect(await tools.showView({ view: "arrangement" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Live shows the session view/) } });
  });
});
