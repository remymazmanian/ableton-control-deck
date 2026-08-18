import { afterAll, describe, expect, it } from "vitest";
import { AbletonCommands } from "../src/commands.js";
import { LiveTools } from "../src/live-tools.js";
import { AbletonClient } from "../src/ableton-client.js";
import { PluginTools } from "../src/plugin-tools.js";
import { oscInt } from "../src/types.js";

const enabled = process.env.ABLETON_INTEGRATION === "1";
const ableton = enabled ? new AbletonClient({ timeoutMs: 12_000 }) : undefined;
const commands = ableton ? new AbletonCommands(ableton) : undefined;
const live = ableton ? new LiveTools(ableton) : undefined;
const plugins = ableton ? new PluginTools(ableton, ableton) : undefined;

describe.skipIf(!enabled)("Ableton reversible integration", () => {
  afterAll(() => { ableton?.close(); });
  it("gets status and tempo", async () => { expect((await commands!.status()).ok).toBe(true); expect((await commands!.getTempo()).ok).toBe(true); });
  it("creates a C-minor clip and restores the set", async () => {
    const before = await commands!.listTracks();
    const count = (before.data as { tracks: unknown[] }).tracks.length;
    let created = false;
    try {
      expect((await commands!.createMidiTrack(-1)).ok).toBe(true);
      created = true;
      expect((await commands!.renameTrack(count, "Control Deck Integration Test")).ok).toBe(true);
      expect((await commands!.createMidiClip(count, 0, 4)).ok).toBe(true);
      expect((await commands!.addMidiNotes(count, 0, [
        { pitch: "C3", startTime: 0, duration: 4, velocity: 100 },
        { pitch: "Eb3", startTime: 0, duration: 4, velocity: 100 },
        { pitch: "G3", startTime: 0, duration: 4, velocity: 100 }
      ])).ok).toBe(true);
    } finally {
      if (created) expect((await commands!.deleteTrack(count, true)).ok).toBe(true);
    }
    const after = await commands!.listTracks();
    expect((after.data as { tracks: unknown[] }).tracks.length).toBe(count);
  }, 20_000);

  it("changes and restores transport state", async () => {
    const beforeResult = await live!.getTransport();
    const signatureResult = await live!.getTimeSignature();
    expect(beforeResult.ok).toBe(true); expect(signatureResult.ok).toBe(true);
    const before = beforeResult.data as { isPlaying: boolean; songPositionBeats: number; metronome: boolean };
    const signature = signatureResult.data as { numerator: number; denominator: number };
    try {
      expect((await live!.setTimeSignature(signature.numerator, signature.denominator)).ok).toBe(true);
      expect((await live!.setSongPosition(before.songPositionBeats + 1)).ok).toBe(true);
      expect((await live!.toggleMetronome()).ok).toBe(true);
      expect((await live!.toggleMetronome()).ok).toBe(true);
      expect((await live!.play()).ok).toBe(true);
      expect((await live!.stop()).ok).toBe(true);
      expect((await live!.setRecording(true, true)).dryRun).toBe(true);
    } finally {
      const current = (await live!.getTransport()).data as { isPlaying: boolean; metronome: boolean };
      if (current?.metronome !== before.metronome) await live!.toggleMetronome();
      if (current?.isPlaying && !before.isPlaying) await live!.stop();
      await live!.setTimeSignature(signature.numerator, signature.denominator);
      await live!.setSongPosition(before.songPositionBeats);
      if (before.isPlaying) await live!.continuePlayback();
    }
    const after = (await live!.getTransport()).data as { isPlaying: boolean; songPositionBeats: number; metronome: boolean };
    expect(after.isPlaying).toBe(before.isPlaying);
    expect(after.metronome).toBe(before.metronome);
    expect(after.songPositionBeats).toBeCloseTo(before.songPositionBeats, 2);
  }, 20_000);

  it("loads a VST3 on an explicit temporary audio track and restores the set", async () => {
    const before = await commands!.listTracks();
    const count = (before.data as { tracks: unknown[] }).tracks.length;
    const selectedBefore = (await live!.getSelectedTrack()).data as { index: number; name: string };
    let created = false;
    try {
      expect((await commands!.createAudioTrack(-1)).ok).toBe(true);
      created = true;
      expect((await commands!.renameTrack(count, "Control Deck VST Integration Test")).ok).toBe(true);
      await ableton!.send("/live/view/set/selected_track", [oscInt(selectedBefore.index)]);
      expect(((await live!.getSelectedTrack()).data as { index: number }).index).toBe(selectedBefore.index);
      const loaded = await plugins!.loadPlugin({
        trackIndex: count,
        expectedTrackName: "Control Deck VST Integration Test",
        name: "Pro-Q 4",
        format: "vst3",
        expectedPath: "Plugins/VST3/FabFilter/Pro-Q 4"
      });
      expect(loaded.ok).toBe(true);
      expect(loaded.data).toMatchObject({ deviceCountBefore: 0, deviceCountAfter: 1, selectedTrackBefore: selectedBefore.index, selectionRestored: true, newDevices: [{ name: "Pro-Q 4", className: "PluginDevice" }] });
      const pluginDevices = await live!.listPluginDevices(count);
      expect(pluginDevices).toMatchObject({ ok: true, data: { deviceCount: 1, tracks: [{ devices: [{ index: 0, name: "Pro-Q 4", className: "PluginDevice" }] }] } });
      const parametersResult = await live!.getPluginParameters(count, 0, "Pro-Q 4");
      expect(parametersResult.ok).toBe(true);
      const parameters = (parametersResult.data as { parameters: Array<{ index: number; name: string; normalizedValue: number; displayValue: string }> }).parameters;
      const deviceOn = parameters.find(parameter => parameter.name === "Device On");
      expect(deviceOn).toBeDefined();
      const target = deviceOn!.normalizedValue >= 0.5 ? 0 : 1;
      const controlled = await live!.setPluginParameter({
        trackIndex: count, deviceIndex: 0, expectedDeviceName: "Pro-Q 4",
        parameterName: deviceOn!.name, parameterIndex: deviceOn!.index, normalizedValue: target
      });
      expect(controlled).toMatchObject({ ok: true, data: { deviceName: "Pro-Q 4", parameterName: "Device On", requestedNormalizedValue: target, normalizedValue: target } });
      const found = await live!.findPluginParameter(count, 0, "Pro-Q 4", "Device On", true);
      expect(found).toMatchObject({ ok: true, data: { matched: 1, parameters: [{ name: "Device On", normalizedValue: target }] } });
      expect(((await live!.getSelectedTrack()).data as { index: number }).index).toBe(selectedBefore.index);
    } finally {
      if (created) expect((await commands!.deleteTrack(count, true)).ok).toBe(true);
    }
    const after = await commands!.listTracks();
    expect((after.data as { tracks: unknown[] }).tracks.length).toBe(count);
    expect(((await live!.getSelectedTrack()).data as { index: number }).index).toBe(selectedBefore.index);
  }, 45_000);
});
