import { findCreatedMidiClip, MAX_ARRANGEMENT_BEATS, MAX_NOTES_PER_CALL, notesStartingInRange, parseArrangementClips, parseArrangementNotes, resolveArrangementClip, verifyAddedNotes, verifyModifiedNotes, verifyRemovedNotes, type ArrangementClipDescriptor, type ArrangementNote } from "./arrangement-clips.js";
import { JsonLogger } from "./logger.js";
import { oscFloat, oscInt, type LiveControlClient, type OscArgument, type ToolResult } from "./types.js";
import { noteNameToMidi, trackIndexSchema, validateNotes } from "./validation.js";

const bool = (value: unknown) => value === true || value === 1;
const last = (values: unknown[]) => values.at(-1);

interface DeviceDescriptor {
  index: number;
  id: string;
  name: string;
  type: number;
  className: string;
}

interface DeviceParameterDescriptor {
  index: number;
  id: string;
  name: string;
  value: number;
  normalizedValue: number;
  minimum: number;
  maximum: number;
  displayValue: string;
  enabled: null;
}

export class LiveTools {
  constructor(private readonly live: LiveControlClient, private readonly logger = new JsonLogger(), private readonly defaultDryRun = false) {}

  private async fail<T>(tool: string, started: number, error: unknown): Promise<ToolResult<T>> {
    const message = error instanceof Error ? error.message : String(error);
    await this.logger.write({ tool, durationMs: performance.now() - started, success: false, error: message });
    return { ok: false, dryRun: false, tool, error: { code: "ABLETON_OPERATION_FAILED", message } };
  }

  private async read<T>(tool: string, fn: () => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    try {
      const data = await fn();
      await this.logger.write({ tool, durationMs: performance.now() - started, success: true, response: data });
      return { ok: true, dryRun: false, tool, data };
    } catch (error) { return this.fail(tool, started, error); }
  }

  private async mutate<T>(tool: string, args: unknown, operations: Array<{ address: string; args?: OscArgument[] }>, dryRun: boolean, verify: () => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    const normalized = operations.map(op => ({ address: op.address, args: op.args ?? [] }));
    if (dryRun || this.defaultDryRun) {
      await this.logger.write({ tool, args, liveOperation: normalized, durationMs: performance.now() - started, success: true, dryRun: true });
      return { ok: true, dryRun: true, tool, intendedOperations: normalized };
    }
    try {
      for (const op of normalized) await this.live.send(op.address, op.args);
      const data = await verify();
      await this.logger.write({ tool, args, liveOperation: normalized, response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool, data };
    } catch (error) { return this.fail(tool, started, error); }
  }

  private async songValue(property: string): Promise<unknown> {
    return last((await this.live.query(`/live/song/get/${property}`)).args);
  }

  private async waitForSongValue(property: string, expected: unknown): Promise<unknown> {
    let value: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      value = await this.songValue(property);
      if (typeof expected === "number" && typeof value === "number" ? Math.abs(value - expected) < 0.001 : value === expected) return value;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error(`Verification failed for ${property}: expected ${expected}, received ${value}`);
  }

  getTransport(): Promise<ToolResult> {
    return this.read("get_transport", async () => {
      const [isPlaying, songPosition, tempo, metronome, recordMode, sessionRecord, loop, loopStart, loopLength] = await Promise.all([
        this.songValue("is_playing"), this.songValue("current_song_time"), this.songValue("tempo"),
        this.songValue("metronome"), this.songValue("record_mode"), this.songValue("session_record"),
        this.songValue("loop"), this.songValue("loop_start"), this.songValue("loop_length")
      ]);
      return { isPlaying: bool(isPlaying), songPositionBeats: Number(songPosition), tempo: Number(tempo), metronome: bool(metronome), arrangementRecording: bool(recordMode), sessionRecording: bool(sessionRecord), loop: { enabled: bool(loop), startBeats: Number(loopStart), lengthBeats: Number(loopLength) } };
    });
  }

  getTimeSignature(): Promise<ToolResult> {
    return this.read("get_time_signature", async () => ({ numerator: Number(await this.songValue("signature_numerator")), denominator: Number(await this.songValue("signature_denominator")) }));
  }

  play(dryRun = false): Promise<ToolResult> {
    return this.mutate("play", { dryRun }, [{ address: "/live/song/start_playing" }], dryRun, async () => ({ isPlaying: bool(await this.waitForSongValue("is_playing", true)) }));
  }

  stop(dryRun = false): Promise<ToolResult> {
    return this.mutate("stop", { dryRun }, [{ address: "/live/song/stop_playing" }], dryRun, async () => ({ isPlaying: bool(await this.waitForSongValue("is_playing", false)) }));
  }

  continuePlayback(dryRun = false): Promise<ToolResult> {
    return this.mutate("continue_playback", { dryRun }, [{ address: "/live/song/continue_playing" }], dryRun, async () => ({ isPlaying: bool(await this.waitForSongValue("is_playing", true)) }));
  }

  setTimeSignature(numerator: number, denominator: number, dryRun = false): Promise<ToolResult> {
    if (!Number.isInteger(numerator) || numerator < 1 || numerator > 99) throw new Error("Numerator must be an integer from 1 to 99.");
    if (![1, 2, 4, 8, 16].includes(denominator)) throw new Error("Denominator must be one of 1, 2, 4, 8, or 16.");
    const operations = [
      { address: "/live/song/set/signature_numerator", args: [oscInt(numerator)] },
      { address: "/live/song/set/signature_denominator", args: [oscInt(denominator)] }
    ];
    return this.mutate("set_time_signature", { numerator, denominator, dryRun }, operations, dryRun, async () => {
      const actualNumerator = Number(await this.waitForSongValue("signature_numerator", numerator));
      const actualDenominator = Number(await this.waitForSongValue("signature_denominator", denominator));
      return { numerator: actualNumerator, denominator: actualDenominator, completedActions: operations.map(op => op.address), incompleteActions: [] };
    });
  }

  setSongPosition(positionBeats: number, dryRun = false): Promise<ToolResult> {
    if (!Number.isFinite(positionBeats) || positionBeats < 0) throw new Error("Song position must be a non-negative number of beats.");
    return this.mutate("set_song_position", { positionBeats, dryRun }, [{ address: "/live/song/set/current_song_time", args: [oscFloat(positionBeats)] }], dryRun, async () => ({ songPositionBeats: Number(await this.waitForSongValue("current_song_time", positionBeats)) }));
  }

  async toggleMetronome(dryRun = false): Promise<ToolResult> {
    const current = bool(await this.songValue("metronome"));
    const next = !current;
    return this.mutate("toggle_metronome", { dryRun }, [{ address: "/live/song/set/metronome", args: [next] }], dryRun, async () => ({ metronome: bool(await this.waitForSongValue("metronome", next)) }));
  }

  setRecording(enabled: boolean, dryRun = false): Promise<ToolResult> {
    const tool = enabled ? "start_recording" : "stop_recording";
    return this.mutate(tool, { dryRun }, [{ address: "/live/song/set/record_mode", args: [enabled] }], dryRun, async () => ({ arrangementRecording: bool(await this.waitForSongValue("record_mode", enabled)) }));
  }

  listScenes(): Promise<ToolResult> {
    return this.read("list_scenes", async () => {
      const names = (await this.live.query("/live/song/get/scenes/name")).args;
      return { scenes: names.map((name, index) => ({ index, id: `scene:${index}`, name: String(name) })) };
    });
  }

  getSelectedTrack(): Promise<ToolResult> {
    return this.read("get_selected_track", async () => {
      const index = Number(last((await this.live.query("/live/view/get/selected_track")).args));
      const names = (await this.live.query("/live/song/get/track_names")).args.map(String);
      return { index, id: `track:${index}`, name: names[index] };
    });
  }

  getSelectedClip(): Promise<ToolResult> {
    return this.read("get_selected_clip", async () => {
      const reply = (await this.live.query("/live/view/get/selected_clip")).args;
      const trackIndex = Number(reply[0]); const sceneIndex = Number(reply[1]);
      const hasClip = bool(last((await this.live.query("/live/clip_slot/get/has_clip", [oscInt(trackIndex), oscInt(sceneIndex)])).args));
      return { trackIndex, trackId: `track:${trackIndex}`, sceneIndex, sceneId: `scene:${sceneIndex}`, hasClip };
    });
  }

  getTrack(trackIndex: number): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    return this.read("get_track", async () => {
      const names = (await this.live.query("/live/song/get/track_names")).args.map(String);
      if (trackIndex >= names.length) throw new Error(`Track index ${trackIndex} does not exist.`);
      const arg = [oscInt(trackIndex)];
      const props = ["can_be_armed", "arm", "mute", "solo", "is_foldable", "is_grouped", "playing_slot_index", "volume", "panning"];
      const values = await Promise.all(props.map(prop => this.live.query(`/live/track/get/${prop}`, arg).then(reply => last(reply.args))));
      const data = Object.fromEntries(props.map((prop, index) => [prop, values[index]]));
      return { index: trackIndex, id: `track:${trackIndex}`, name: names[trackIndex], canBeArmed: bool(data.can_be_armed), armed: bool(data.arm), muted: bool(data.mute), soloed: bool(data.solo), isGroup: bool(data.is_foldable), isGrouped: bool(data.is_grouped), playingSlotIndex: Number(data.playing_slot_index), volume: Number(data.volume), pan: Number(data.panning) };
    });
  }

  listClips(trackIndex?: number): Promise<ToolResult> {
    if (trackIndex !== undefined) trackIndexSchema.parse(trackIndex);
    return this.read("list_clips", async () => {
      const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
      const indices = trackIndex === undefined ? trackNames.map((_name, index) => index) : [trackIndex];
      const tracks = [];
      for (const index of indices) {
        if (index >= trackNames.length) throw new Error(`Track index ${index} does not exist.`);
        const arg = [oscInt(index)];
        const [namesReply, lengthsReply] = await Promise.all([this.live.query("/live/track/get/clips/name", arg), this.live.query("/live/track/get/clips/length", arg)]);
        const names = namesReply.args.slice(1); const lengths = lengthsReply.args.slice(1);
        const clips = names.map((name, sceneIndex) => name === null ? null : ({ trackIndex: index, sceneIndex, id: `clip:${index}:${sceneIndex}`, name: String(name), lengthBeats: Number(lengths[sceneIndex]) })).filter(Boolean);
        tracks.push({ trackIndex: index, trackId: `track:${index}`, trackName: trackNames[index], clips });
      }
      return { tracks };
    });
  }

  listDevices(trackIndex: number): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    return this.read("list_devices", async () => ({ trackIndex, trackId: `track:${trackIndex}`, devices: await this.getDevicesOnTrack(trackIndex) }));
  }

  listPluginDevices(trackIndex?: number): Promise<ToolResult> {
    if (trackIndex !== undefined) trackIndexSchema.parse(trackIndex);
    return this.read("list_plugin_devices", async () => {
      const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
      if (trackIndex !== undefined && trackIndex >= trackNames.length) throw new Error(`Track index ${trackIndex} does not exist.`);
      const indices = trackIndex === undefined ? trackNames.map((_name, index) => index) : [trackIndex];
      const tracks = [];
      let deviceCount = 0;
      for (const index of indices) {
        const devices = (await this.getDevicesOnTrack(index)).filter(device => device.className === "PluginDevice");
        deviceCount += devices.length;
        tracks.push({ trackIndex: index, trackId: `track:${index}`, trackName: trackNames[index], devices });
      }
      return { tracks, deviceCount };
    });
  }

  getDeviceParameters(trackIndex: number, deviceIndex: number): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0) throw new Error("Device index must be a non-negative integer.");
    return this.read("get_device_parameters", async () => {
      const device = await this.assertDevice(trackIndex, deviceIndex);
      return { trackIndex, deviceIndex, device, parameters: await this.getParameterSnapshot(trackIndex, deviceIndex) };
    });
  }

  getPluginParameters(trackIndex: number, deviceIndex: number, expectedDeviceName: string): Promise<ToolResult> {
    if (![trackIndex, deviceIndex].every(value => Number.isInteger(value) && value >= 0)) throw new Error("Track and device indices must be non-negative integers.");
    return this.read("get_plugin_parameters", async () => {
      const device = await this.assertPluginDevice(trackIndex, deviceIndex, expectedDeviceName);
      return { trackIndex, deviceIndex, device, parameters: await this.getParameterSnapshot(trackIndex, deviceIndex) };
    });
  }

  findPluginParameter(trackIndex: number, deviceIndex: number, expectedDeviceName: string, query: string, exact = false): Promise<ToolResult> {
    if (![trackIndex, deviceIndex].every(value => Number.isInteger(value) && value >= 0)) throw new Error("Track and device indices must be non-negative integers.");
    if (!query.trim()) throw new Error("Parameter query must not be empty.");
    return this.read("find_plugin_parameter", async () => {
      const device = await this.assertPluginDevice(trackIndex, deviceIndex, expectedDeviceName);
      const needle = query.trim().toLocaleLowerCase();
      const parameters = await this.getParameterSnapshot(trackIndex, deviceIndex);
      const matches = parameters.filter(parameter => exact ? parameter.name.toLocaleLowerCase() === needle : parameter.name.toLocaleLowerCase().includes(needle));
      return { trackIndex, deviceIndex, device, query, exact, matched: matches.length, parameters: matches.slice(0, 100), truncated: matches.length > 100 };
    });
  }

  async getLiveSet(): Promise<ToolResult> {
    return this.read("get_live_set", async () => {
      const version = (await this.live.query("/live/application/get/version")).args;
      const [transport, signature, scenes, selectedTrack] = await Promise.all([this.getTransport(), this.getTimeSignature(), this.listScenes(), this.getSelectedTrack()]);
      const tracks = (await this.live.query("/live/song/get/track_names")).args.map((name, index) => ({ index, id: `track:${index}`, name: String(name) }));
      return { liveVersion: { major: Number(version[0]), minor: Number(version[1]) }, transport: transport.data, timeSignature: signature.data, tracks, scenes: scenes.data, selectedTrack: selectedTrack.data };
    });
  }

  async setDeviceParameter(trackIndex: number, deviceIndex: number, parameterIndex: number, value: number, expectedDeviceName: string, dryRun = false): Promise<ToolResult> {
    if (![trackIndex, deviceIndex, parameterIndex].every(value => Number.isInteger(value) && value >= 0)) throw new Error("Track, device, and parameter indices must be non-negative integers.");
    if (!Number.isFinite(value)) throw new Error("Parameter value must be finite.");
    const device = await this.assertDevice(trackIndex, deviceIndex);
    if (device.name !== expectedDeviceName) throw new Error(`Device safeguard failed: expected ${expectedDeviceName}, found ${device.name}.`);
    return this.mutate("set_device_parameter", { trackIndex, deviceIndex, parameterIndex, value, expectedDeviceName, dryRun }, [{ address: "/live/device/set/parameter/value", args: [oscInt(trackIndex), oscInt(deviceIndex), oscInt(parameterIndex), oscFloat(value)] }], dryRun, async () => {
      const reply = await this.live.query("/live/device/get/parameter/value", [oscInt(trackIndex), oscInt(deviceIndex), oscInt(parameterIndex)]);
      const actual = Number(last(reply.args));
      if (Math.abs(actual - value) > 0.0001) throw new Error(`Parameter verification failed: expected ${value}, received ${actual}.`);
      return { trackIndex, deviceIndex, parameterIndex, value: actual, deviceName: device.name };
    });
  }

  async setPluginParameter(input: { trackIndex: number; deviceIndex: number; expectedDeviceName: string; parameterName: string; parameterIndex?: number; normalizedValue: number; dryRun?: boolean }): Promise<ToolResult> {
    const { trackIndex, deviceIndex, expectedDeviceName, parameterName, parameterIndex, normalizedValue, dryRun = false } = input;
    if (![trackIndex, deviceIndex].every(value => Number.isInteger(value) && value >= 0)) throw new Error("Track and device indices must be non-negative integers.");
    if (parameterIndex !== undefined && (!Number.isInteger(parameterIndex) || parameterIndex < 0)) throw new Error("Parameter index must be a non-negative integer.");
    if (!parameterName.trim()) throw new Error("Parameter name must not be empty.");
    if (!Number.isFinite(normalizedValue) || normalizedValue < 0 || normalizedValue > 1) throw new Error("Normalized value must be between 0 and 1.");
    const device = await this.assertPluginDevice(trackIndex, deviceIndex, expectedDeviceName);
    const parameters = await this.getParameterSnapshot(trackIndex, deviceIndex);
    const parameter = this.resolveParameter(parameters, parameterName, parameterIndex);
    const requestedValue = parameter.minimum + normalizedValue * (parameter.maximum - parameter.minimum);
    const operation = { address: "/live/device/set/parameter/value", args: [oscInt(trackIndex), oscInt(deviceIndex), oscInt(parameter.index), oscFloat(requestedValue)] };
    return this.mutate("set_plugin_parameter", { ...input, dryRun }, [operation], dryRun, async () => {
      const args = [oscInt(trackIndex), oscInt(deviceIndex), oscInt(parameter.index)];
      const [valueReply, displayReply] = await Promise.all([
        this.live.query("/live/device/get/parameter/value", args),
        this.live.query("/live/device/get/parameter/value_string", args)
      ]);
      const actualValue = Number(last(valueReply.args));
      if (!Number.isFinite(actualValue) || actualValue < parameter.minimum - 0.0001 || actualValue > parameter.maximum + 0.0001) throw new Error(`Plugin parameter read-back failed for ${parameter.name}.`);
      const actualNormalizedValue = parameter.maximum === parameter.minimum ? 0 : (actualValue - parameter.minimum) / (parameter.maximum - parameter.minimum);
      return {
        trackIndex, deviceIndex, deviceName: device.name, className: device.className,
        parameterIndex: parameter.index, parameterName: parameter.name,
        previousValue: parameter.value, previousNormalizedValue: parameter.normalizedValue, previousDisplayValue: parameter.displayValue,
        requestedValue, requestedNormalizedValue: normalizedValue,
        value: actualValue, normalizedValue: actualNormalizedValue, displayValue: String(last(displayReply.args)),
        quantized: Math.abs(actualValue - requestedValue) > 0.0001
      };
    });
  }

  private async cuePoints(): Promise<Array<{ name: string; timeBeats: number }>> {
    const values = (await this.live.query("/live/song/get/cue_points")).args;
    const cues = [];
    for (let i = 0; i + 1 < values.length; i += 2) cues.push({ name: String(values[i]), timeBeats: Number(values[i + 1]) });
    return cues.sort((a, b) => a.timeBeats - b.timeBeats);
  }

  private async requireArrangementMidiClip(input: { trackIndex: number; expectedTrackName: string; clipIndex?: number; startBeats?: number }): Promise<{ trackName: string; clip: ArrangementClipDescriptor }> {
    trackIndexSchema.parse(input.trackIndex);
    if (!input.expectedTrackName.trim()) throw new Error("Expected track name must not be empty.");
    const trackName = await this.assertTrackName(input.trackIndex, input.expectedTrackName);
    const clip = resolveArrangementClip(await this.arrangementClips(input.trackIndex), input);
    if (clip.kind !== "midi") throw new Error(`Arrangement clip ${clip.index} is ${clip.kind}, not MIDI.`);
    return { trackName, clip };
  }

  private arrangementNoteArgs(trackIndex: number, trackName: string, clip: ArrangementClipDescriptor): OscArgument[] {
    return [oscInt(trackIndex), trackName, oscInt(clip.index), oscFloat(clip.startBeats)];
  }

  private async readArrangementNotes(trackIndex: number, clip: ArrangementClipDescriptor, prefix: OscArgument[]) {
    const parsed = parseArrangementNotes((await this.live.query("/live/arrangement_clip/get/notes", prefix)).args, { trackIndex, clipIndex: clip.index });
    if (Math.abs(parsed.startBeats - clip.startBeats) >= 0.001) throw new Error(`Arrangement clip ${clip.index} moved: expected start ${clip.startBeats}, Live reports ${parsed.startBeats}.`);
    if (parsed.kind !== "midi") throw new Error(`Arrangement clip ${clip.index} is ${parsed.kind}, not MIDI.`);
    return parsed;
  }

  private async arrangementClips(trackIndex: number): Promise<ArrangementClipDescriptor[]> {
    const reply = await this.live.query("/live/track/get/arrangement_clips", [oscInt(trackIndex)]);
    return parseArrangementClips(reply.args, trackIndex);
  }

  listLocators(): Promise<ToolResult> {
    return this.read("list_locators", async () => ({ locators: await this.cuePoints() }));
  }

  private hasCueAt(cues: Array<{ timeBeats: number }>, timeBeats: number): boolean {
    return cues.some(cue => Math.abs(cue.timeBeats - timeBeats) < 0.001);
  }

  private async waitForCue(timeBeats: number, present: boolean): Promise<Array<{ name: string; timeBeats: number }>> {
    let cues = await this.cuePoints();
    for (let attempt = 0; attempt < 10 && this.hasCueAt(cues, timeBeats) !== present; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 75));
      cues = await this.cuePoints();
    }
    if (this.hasCueAt(cues, timeBeats) !== present) throw new Error(`Locator at ${timeBeats} beats is ${present ? "missing" : "still present"}.`);
    return cues;
  }

  /**
   * Live adds and removes a locator at the playhead, and applies a playhead move
   * on its next tick. Move the playhead, wait until Live reports it there, run
   * the change, then put the playhead back where it was.
   */
  private async withPlayheadAt<T>(timeBeats: number, run: () => Promise<T>): Promise<T> {
    if (bool(await this.songValue("is_playing"))) throw new Error("Stop playback first: Live adds and removes locators at the playhead, which moves while playing.");
    const previous = Number(await this.songValue("current_song_time"));
    const moveTo = async (beats: number) => {
      if (Math.abs(Number(await this.songValue("current_song_time")) - beats) < 0.001) return;
      await this.live.send("/live/song/set/current_song_time", [oscFloat(beats)]);
      await this.waitForSongValue("current_song_time", beats);
    };
    await moveTo(timeBeats);
    try {
      return await run();
    } finally {
      await moveTo(previous).catch(() => undefined);
    }
  }

  async addLocator(timeBeats: number, name: string, dryRun = false): Promise<ToolResult> {
    if (!Number.isFinite(timeBeats) || timeBeats < 0) throw new Error("Locator time must be a non-negative number of beats.");
    if (!name.trim()) throw new Error("Locator name must not be empty.");
    const create = { address: "/live/song/create_cue_point", args: [oscFloat(timeBeats)] };
    const rename = { address: "/live/cue_point/set_name", args: [oscFloat(timeBeats), name] };
    if (dryRun || this.defaultDryRun) return this.mutate("add_locator", { timeBeats, name, dryRun }, [create, rename], true, async () => ({}));
    const confirmName = async () => {
      const cue = (await this.cuePoints()).find(item => Math.abs(item.timeBeats - timeBeats) < 0.001);
      if (!cue || cue.name !== name) throw new Error(`Locator verification failed at ${timeBeats} beats.`);
      return cue;
    };
    // An existing locator is only renamed, so the playhead never needs to move.
    if (this.hasCueAt(await this.cuePoints(), timeBeats)) return this.mutate("add_locator", { timeBeats, name }, [rename], false, confirmName);
    return this.withPlayheadAt(timeBeats, () => this.mutate("add_locator", { timeBeats, name }, [create], false, async () => {
      await this.waitForCue(timeBeats, true);
      await this.live.send(rename.address, rename.args);
      return confirmName();
    }));
  }

  async deleteLocator(timeBeats: number, dryRun = false): Promise<ToolResult> {
    const operation = { address: "/live/song/delete_cue_point", args: [oscFloat(timeBeats)] };
    if (dryRun || this.defaultDryRun) return this.mutate("delete_locator", { timeBeats, dryRun }, [operation], true, async () => ({}));
    if (!this.hasCueAt(await this.cuePoints(), timeBeats)) throw new Error(`No locator at ${timeBeats} beats. List them with list_locators.`);
    return this.withPlayheadAt(timeBeats, () => this.mutate("delete_locator", { timeBeats }, [operation], false, async () => ({ deletedAtBeats: timeBeats, locators: await this.waitForCue(timeBeats, false) })));
  }

  listArrangementClips(trackIndex: number): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    return this.read("list_arrangement_clips", async () => ({ trackIndex, trackName: await this.assertTrack(trackIndex), clips: await this.arrangementClips(trackIndex) }));
  }

  async createArrangementMidiClip(input: { trackIndex: number; expectedTrackName: string; startBeats: number; lengthBeats: number; name?: string; dryRun?: boolean }): Promise<ToolResult> {
    const { trackIndex, expectedTrackName, startBeats, lengthBeats, name, dryRun = false } = input;
    trackIndexSchema.parse(trackIndex);
    if (!expectedTrackName.trim()) throw new Error("Expected track name must not be empty.");
    if (!Number.isFinite(startBeats) || startBeats < 0 || startBeats > MAX_ARRANGEMENT_BEATS || !Number.isFinite(lengthBeats) || lengthBeats <= 0 || startBeats + lengthBeats > MAX_ARRANGEMENT_BEATS) {
      throw new Error(`Arrangement clip start must be from 0 to ${MAX_ARRANGEMENT_BEATS} beats, length must be positive, and the clip must end inside that range.`);
    }
    if (name !== undefined && (!name.trim() || /[\u0000\r\n]/.test(name) || name.length > 128)) throw new Error("Clip name must be a single line of 1 to 128 characters.");
    const trackName = await this.assertTrackName(trackIndex, expectedTrackName);
    const args: OscArgument[] = [oscInt(trackIndex), trackName, oscFloat(startBeats), oscFloat(lengthBeats)];
    if (name !== undefined) args.push(name);
    return this.mutate("create_arrangement_midi_clip", input, [{ address: "/live/track/create_arrangement_midi_clip", args }], dryRun, async () => {
      const clip = findCreatedMidiClip(await this.arrangementClips(trackIndex), startBeats, lengthBeats, name);
      return { trackIndex, trackName, clip };
    });
  }

  async getArrangementClipNotes(input: { trackIndex: number; expectedTrackName: string; clipIndex?: number; startBeats?: number }): Promise<ToolResult> {
    const { trackName, clip } = await this.requireArrangementMidiClip(input);
    const prefix = this.arrangementNoteArgs(input.trackIndex, trackName, clip);
    return this.read("get_arrangement_clip_notes", async () => {
      const parsed = await this.readArrangementNotes(input.trackIndex, clip, prefix);
      return { trackIndex: input.trackIndex, trackName, clip, noteCount: parsed.notes.length, notes: parsed.notes };
    });
  }

  async addArrangementClipNotes(input: { trackIndex: number; expectedTrackName: string; clipIndex?: number; startBeats?: number; notes: Array<{ pitch: number | string; startTime: number; duration: number; velocity: number; mute?: boolean }>; dryRun?: boolean }): Promise<ToolResult> {
    const valid = validateNotes(input.notes);
    if (valid.length > MAX_NOTES_PER_CALL) throw new Error(`At most ${MAX_NOTES_PER_CALL} notes can be added at once.`);
    const { trackName, clip } = await this.requireArrangementMidiClip(input);
    const args = this.arrangementNoteArgs(input.trackIndex, trackName, clip);
    for (const note of valid) args.push(oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(note.velocity), note.mute);
    return this.mutate("add_arrangement_clip_notes", input, [{ address: "/live/arrangement_clip/add/notes", args }], input.dryRun ?? false, async () => {
      const parsed = await this.readArrangementNotes(input.trackIndex, clip, this.arrangementNoteArgs(input.trackIndex, trackName, clip));
      verifyAddedNotes(valid, parsed.notes);
      return { trackIndex: input.trackIndex, trackName, clip, noteCountRequested: valid.length, noteCountInClip: parsed.notes.length, notes: parsed.notes };
    });
  }

  async modifyArrangementClipNotes(input: { trackIndex: number; expectedTrackName: string; clipIndex?: number; startBeats?: number; dryRun?: boolean; notes: Array<{ noteId: number; pitch?: number | string; startTime?: number; duration?: number; velocity?: number; mute?: boolean }> }): Promise<ToolResult> {
    if (!Array.isArray(input.notes) || input.notes.length === 0) throw new Error("At least one note modification is required.");
    if (input.notes.length > MAX_NOTES_PER_CALL) throw new Error(`At most ${MAX_NOTES_PER_CALL} notes can be modified at once.`);
    const seen = new Set<number>();
    for (const note of input.notes) {
      if (!Number.isInteger(note.noteId) || note.noteId < 0) throw new Error("noteId must be a non-negative integer.");
      if (seen.has(note.noteId)) throw new Error(`Note id ${note.noteId} was given more than once.`);
      seen.add(note.noteId);
      if (note.pitch === undefined && note.startTime === undefined && note.duration === undefined && note.velocity === undefined && note.mute === undefined) throw new Error(`Note id ${note.noteId} has no fields to change.`);
    }
    const { trackName, clip } = await this.requireArrangementMidiClip(input);
    const current = await this.readArrangementNotes(input.trackIndex, clip, this.arrangementNoteArgs(input.trackIndex, trackName, clip));
    if (new Set(current.notes.map(note => note.noteId)).size !== current.notes.length) throw new Error("Arrangement clip has duplicate note ids; refusing to modify.");
    const byId = new Map(current.notes.map(note => [note.noteId, note]));
    const desired: ArrangementNote[] = input.notes.map(change => {
      const existing = byId.get(change.noteId);
      if (!existing) throw new Error(`No note with id ${change.noteId} in arrangement clip ${clip.index}.`);
      const pitch = change.pitch === undefined ? existing.pitch : typeof change.pitch === "string" ? noteNameToMidi(change.pitch) : change.pitch;
      const velocity = change.velocity === undefined ? Math.round(existing.velocity) : change.velocity;
      const next = { noteId: change.noteId, pitch, startTime: change.startTime ?? existing.startTime, duration: change.duration ?? existing.duration, velocity, mute: change.mute ?? existing.mute };
      assertOutgoingNote(next, change.velocity === undefined ? 0 : 1);
      return next;
    });
    const args = this.arrangementNoteArgs(input.trackIndex, trackName, clip);
    for (const note of desired) args.push(oscInt(note.noteId), oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(note.velocity), note.mute);
    return this.mutate("modify_arrangement_clip_notes", input, [{ address: "/live/arrangement_clip/modify/notes", args }], input.dryRun ?? false, async () => {
      const parsed = await this.readArrangementNotes(input.trackIndex, clip, this.arrangementNoteArgs(input.trackIndex, trackName, clip));
      verifyModifiedNotes(desired, parsed.notes);
      return { trackIndex: input.trackIndex, trackName, clip, noteCountModified: desired.length, noteCountInClip: parsed.notes.length, notes: parsed.notes };
    });
  }

  async removeArrangementClipNotes(input: { trackIndex: number; expectedTrackName: string; clipIndex?: number; startBeats?: number; fromPitch: number; pitchSpan: number; fromTime: number; timeSpan: number; dryRun?: boolean }): Promise<ToolResult> {
    const { fromPitch, pitchSpan, fromTime, timeSpan } = input;
    if (!Number.isInteger(fromPitch) || fromPitch < 0 || fromPitch > 127 || !Number.isInteger(pitchSpan) || pitchSpan < 1 || fromPitch + pitchSpan > 128) throw new Error("Pitch range must stay inside MIDI pitches 0-127.");
    if (!Number.isFinite(fromTime) || fromTime < 0 || !Number.isFinite(timeSpan) || timeSpan <= 0) throw new Error("fromTime must be >= 0 and timeSpan must be positive. Times are beats from the start of the clip.");
    const { trackName, clip } = await this.requireArrangementMidiClip(input);
    const before = await this.readArrangementNotes(input.trackIndex, clip, this.arrangementNoteArgs(input.trackIndex, trackName, clip));
    const targets = notesStartingInRange(before.notes, { fromPitch, pitchSpan, fromTime, timeSpan });
    if (!targets.length) throw new Error("No notes start in that pitch and time range.");
    const args = [...this.arrangementNoteArgs(input.trackIndex, trackName, clip), oscInt(fromPitch), oscInt(pitchSpan), oscFloat(fromTime), oscFloat(timeSpan)];
    return this.mutate("remove_arrangement_clip_notes", input, [{ address: "/live/arrangement_clip/remove/notes", args }], input.dryRun ?? false, async () => {
      const parsed = await this.readArrangementNotes(input.trackIndex, clip, this.arrangementNoteArgs(input.trackIndex, trackName, clip));
      verifyRemovedNotes(before.notes, targets.map(note => note.noteId), parsed.notes);
      return { trackIndex: input.trackIndex, trackName, clip, fromPitch, pitchSpan, fromTime, timeSpan, removedNoteIds: targets.map(note => note.noteId), removedCount: targets.length, noteCountInClip: parsed.notes.length, notes: parsed.notes };
    });
  }

  async placeClipInArrangement(input: { trackIndex: number; sceneIndex: number; startBeats: number; endBeats: number; dryRun?: boolean }): Promise<ToolResult> {
    const { trackIndex, sceneIndex, startBeats, endBeats, dryRun = false } = input;
    trackIndexSchema.parse(trackIndex);
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0) throw new Error("Scene index must be a non-negative integer.");
    if (!(startBeats >= 0) || !(endBeats > startBeats)) throw new Error("endBeats must be greater than startBeats (both >= 0).");
    const before = dryRun ? 0 : (await this.arrangementClips(trackIndex)).length;
    return this.mutate("place_clip_in_arrangement", input, [{ address: "/live/clip/fill_arrangement", args: [oscInt(trackIndex), oscInt(sceneIndex), oscFloat(startBeats), oscFloat(endBeats)] }], dryRun, async () => {
      const clips = await this.arrangementClips(trackIndex);
      const placed = clips.filter(clip => clip.startBeats >= startBeats - 0.001 && clip.startBeats < endBeats - 0.001);
      if (clips.length <= before || placed.length === 0) throw new Error("Live did not confirm the arrangement clips.");
      return { trackIndex, sceneIndex, startBeats, endBeats, copiesInRange: placed.length, lastEndBeats: Math.max(...placed.map(clip => clip.endBeats)) };
    });
  }

  clearArrangementTrack(trackIndex: number, confirm: boolean, dryRun = false): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    if (!confirm && !dryRun) throw new Error("clear_arrangement_track requires confirm=true.");
    return this.mutate("clear_arrangement_track", { trackIndex, confirm, dryRun }, [{ address: "/live/track/clear_arrangement", args: [oscInt(trackIndex), true] }], dryRun, async () => {
      const clips = await this.arrangementClips(trackIndex);
      if (clips.length) throw new Error(`${clips.length} arrangement clips remain on track ${trackIndex}.`);
      return { trackIndex, cleared: true };
    });
  }

  private async assertTrack(trackIndex: number): Promise<string> {
    const names = (await this.live.query("/live/song/get/track_names")).args.map(String);
    if (trackIndex >= names.length) throw new Error(`Track index ${trackIndex} does not exist.`);
    return names[trackIndex];
  }

  private async assertTrackName(trackIndex: number, expectedTrackName: string): Promise<string> {
    const actual = await this.assertTrack(trackIndex);
    if (actual !== expectedTrackName) throw new Error(`Track safeguard failed: expected '${expectedTrackName}', found '${actual}'.`);
    return actual;
  }

  private async assertDevice(trackIndex: number, deviceIndex: number): Promise<{ name: string; className: string }> {
    await this.assertTrack(trackIndex);
    const args = [oscInt(trackIndex), oscInt(deviceIndex)];
    const [name, className] = await Promise.all([this.live.query("/live/device/get/name", args), this.live.query("/live/device/get/class_name", args)]);
    return { name: String(last(name.args)), className: String(last(className.args)) };
  }

  private async assertPluginDevice(trackIndex: number, deviceIndex: number, expectedDeviceName: string): Promise<{ name: string; className: string }> {
    const device = await this.assertDevice(trackIndex, deviceIndex);
    if (device.name !== expectedDeviceName) throw new Error(`Device safeguard failed: expected ${expectedDeviceName}, found ${device.name}.`);
    if (device.className !== "PluginDevice") throw new Error(`Device '${device.name}' is not a third-party plugin device.`);
    return device;
  }

  private async getDevicesOnTrack(trackIndex: number): Promise<DeviceDescriptor[]> {
    await this.assertTrack(trackIndex);
    const arg = [oscInt(trackIndex)];
    const [names, types, classes] = await Promise.all([
      this.live.query("/live/track/get/devices/name", arg), this.live.query("/live/track/get/devices/type", arg), this.live.query("/live/track/get/devices/class_name", arg)
    ]);
    return names.args.slice(1).map((name, index) => ({ index, id: `device:${trackIndex}:${index}`, name: String(name), type: Number(types.args[index + 1]), className: String(classes.args[index + 1]) }));
  }

  private async getParameterSnapshot(trackIndex: number, deviceIndex: number): Promise<DeviceParameterDescriptor[]> {
    const args = [oscInt(trackIndex), oscInt(deviceIndex)];
    const [names, values, minimums, maximums, displays] = await Promise.all([
      this.live.query("/live/device/get/parameters/name", args), this.live.query("/live/device/get/parameters/value", args),
      this.live.query("/live/device/get/parameters/min", args), this.live.query("/live/device/get/parameters/max", args),
      this.live.query("/live/device/get/parameters/value_string", args)
    ]);
    const nameList = names.args.slice(2); const valueList = values.args.slice(2); const minList = minimums.args.slice(2); const maxList = maximums.args.slice(2); const displayList = displays.args.slice(2);
    const parameters: DeviceParameterDescriptor[] = [];
    for (let index = 0; index < nameList.length; index++) {
      const value = Number(valueList[index]); const minimum = Number(minList[index]); const maximum = Number(maxList[index]);
      parameters.push({ index, id: `parameter:${trackIndex}:${deviceIndex}:${index}`, name: String(nameList[index]), value, normalizedValue: maximum === minimum ? 0 : (value - minimum) / (maximum - minimum), minimum, maximum, displayValue: String(displayList[index]), enabled: null });
    }
    return parameters;
  }

  private resolveParameter(parameters: DeviceParameterDescriptor[], parameterName: string, parameterIndex?: number): DeviceParameterDescriptor {
    const target = parameterName.trim().toLocaleLowerCase();
    if (parameterIndex !== undefined) {
      const parameter = parameters[parameterIndex];
      if (!parameter) throw new Error(`Parameter index ${parameterIndex} does not exist.`);
      if (parameter.name.toLocaleLowerCase() !== target) throw new Error(`Parameter safeguard failed: expected '${parameterName}', found '${parameter.name}' at index ${parameterIndex}.`);
      return parameter;
    }
    const matches = parameters.filter(parameter => parameter.name.toLocaleLowerCase() === target);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Multiple parameters are named '${parameterName}'; provide parameterIndex.`);
    throw new Error(`Plugin parameter '${parameterName}' was not found.`);
  }
}

function assertOutgoingNote(note: { pitch: number; startTime: number; duration: number; velocity: number }, velocityMin: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new Error("Pitch must be an integer from 0 to 127.");
  if (!Number.isFinite(note.startTime) || note.startTime < 0) throw new Error("Note start must be a non-negative number of beats.");
  if (!Number.isFinite(note.duration) || note.duration <= 0) throw new Error("Note duration must be positive.");
  if (!Number.isInteger(note.velocity) || note.velocity < velocityMin || note.velocity > 127) throw new Error(`Velocity must be an integer from ${velocityMin} to 127.`);
}
