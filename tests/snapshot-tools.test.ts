import { describe, expect, it } from "vitest";
import { diffSnapshots, type SetSnapshot } from "../src/snapshot-tools.js";

const base = (): SetSnapshot => ({
  name: "a", takenAt: "t", tempo: 124, signature: "4/4", song: { key: "A", scaleName: "Minor", loop: { enabled: false } },
  scenes: [{ name: "", color: null, tempo: null, timeSignature: null }],
  tracks: [
    { kind: "track", index: 0, name: "Keys", mix: { volume: "0.0 dB", pan: "C", mute: false, solo: false, sends: ["-inf dB"] }, routing: { output_routing_type: "Main" }, devices: [{ name: "Drift", className: "Drift", enabled: true, parameters: { "Device On": "On", "LP Freq": "20.0 kHz" } }] },
    { kind: "master", index: 0, name: "Main", mix: { volume: "0.0 dB", pan: "C", mute: null, solo: null, sends: [] }, routing: null, devices: [] }
  ],
  clips: [{ track: 0, scene: 0, name: "Chords", kind: "midi", props: { name: "Chords", looping: true }, noteCount: 16, notesHash: "aaa" }]
});

describe("diffSnapshots", () => {
  it("reports nothing for identical snapshots", () => {
    expect(diffSnapshots(base(), base())).toEqual([]);
  });

  it("describes every kind of change in plain words", () => {
    const after = base();
    after.tempo = 128;
    after.song = { ...after.song, key: "C" };
    after.tracks[0].mix.volume = "-6.0 dB";
    after.tracks[0].mix.sends[0] = "-12.0 dB";
    after.tracks[0].devices[0].enabled = false;
    after.tracks[0].devices[0].parameters["LP Freq"] = "2.00 kHz";
    after.clips[0].noteCount = 18; after.clips[0].notesHash = "bbb";
    after.clips[0].props.looping = false;
    after.clips.push({ track: 0, scene: 1, name: "Fill", kind: "midi", props: { name: "Fill" }, noteCount: 4, notesHash: "ccc" });
    after.tracks.splice(1, 0, { kind: "track", index: 1, name: "Pad", mix: { volume: "0.0 dB", pan: "C", mute: false, solo: false, sends: [] }, routing: null, devices: [] });
    const changes = diffSnapshots(base(), after);
    expect(changes).toEqual(expect.arrayContaining([
      "Tempo: 124 → 128 BPM",
      "Song key: A → C",
      "Track 'Keys': volume 0.0 dB → -6.0 dB",
      "Track 'Keys': send A -inf dB → -12.0 dB",
      "Track 'Keys': 'Drift' turned off",
      "Track 'Keys': 'Drift' LP Freq 20.0 kHz → 2.00 kHz",
      "Clip 'Chords' (track 1, scene 1): looping true → false",
      "Clip 'Chords' (track 1, scene 1): notes changed (16 → 18 notes)",
      "Clip 'Fill' (track 1, scene 2) was added",
      "Track 'Pad' was added (or renamed to this)"
    ]));
  });

  it("notices a removed track, a changed device chain, and a deleted clip", () => {
    const after = base();
    after.tracks[0].devices = [];
    after.clips = [];
    const changes = diffSnapshots(base(), after);
    expect(changes).toContain("Track 'Keys': devices Drift → (none)");
    expect(changes).toContain("Clip 'Chords' (track 1, scene 1) was deleted");
    const gone = base(); gone.tracks.shift();
    expect(diffSnapshots(base(), gone)).toContain("Track 'Keys' was removed or renamed");
  });
});
