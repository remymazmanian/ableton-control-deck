import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { MAX_ARRANGEMENT_BEATS, MAX_NOTES_PER_CALL, notesStartingInRange, parseArrangementClips, parseNoteBody, type ArrangementClipDescriptor, verifyModifiedNotes, verifyRemovedNotes, type ArrangementNote } from "./arrangement-clips.js";
import { JsonLogger } from "./logger.js";
import { assertOutgoingNote, noteNameToMidi } from "./validation.js";
import { oscFloat, oscInt, type LiveControlClient, type OscArgument, type ToolResult } from "./types.js";

export type TrackKind = "track" | "return" | "master";

export const LAUNCH_MODES = ["trigger", "gate", "toggle", "repeat"] as const;
export const LAUNCH_QUANTIZATIONS = ["global", "none", "8 bars", "4 bars", "2 bars", "1 bar", "1/2", "1/2T", "1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32"] as const;
export const WARP_MODES = ["beats", "tones", "texture", "re-pitch", "complex", "rex", "complex pro"] as const;
export type LaunchMode = typeof LAUNCH_MODES[number];
export type LaunchQuantization = typeof LAUNCH_QUANTIZATIONS[number];
export type WarpMode = typeof WARP_MODES[number];

const NO_SEND = -1;
const DB_TOLERANCE = 0.15;
const VALUE_TOLERANCE = 0.0001;
const TIME_TOLERANCE = 0.001;
const POLL_ATTEMPTS = 12;
/** A large file on a slow drive can take a few seconds to load. */
const SAMPLE_POLL_ATTEMPTS = 80;
const POLL_DELAY_MS = 75;
const DB_RE = /^\s*(-?inf|[-+]?\d+(?:\.\d+)?)\s*dB\s*$/i;

export interface SendState { index: number; returnName: string | null; value: number; display: string; db: number | null }
export interface MixerState {
  trackKind: TrackKind;
  trackIndex: number;
  name: string;
  volume: number;
  volumeDisplay: string;
  volumeDb: number | null;
  pan: number;
  panDisplay: string;
  mute: boolean | null;
  solo: boolean | null;
  canBeArmed: boolean;
  arm: boolean | null;
  sends: SendState[];
}

export interface SceneState {
  index: number;
  name: string;
  color: string | null;
  tempo: number | null;
  timeSignature: { numerator: number; denominator: number } | null;
  triggered: boolean;
}

export interface TrackPlayback { trackIndex: number; name: string; playingSlotIndex: number; firedSlotIndex: number; state: "playing" | "queued" | "stopping" | "stopped" }

/** Parse a dB display such as "-6.0 dB". -inf comes back as -Infinity; anything else is null. */
export function parseDb(display: string): number | null {
  const match = DB_RE.exec(display);
  if (!match) return null;
  return match[1].toLowerCase() === "-inf" ? -Infinity : Number(match[1]);
}

/** The remote script drops NUL characters and turns line breaks into spaces before naming. */
export const SAMPLE_EXTENSIONS = [".wav", ".aif", ".aiff", ".mp3", ".flac"];

export function cleanName(name: string): string {
  return name.replace(/\x00/g, "").replace(/[\r\n]/g, " ").trim();
}

export function colorToHex(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
}

export function hexToColor(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Color '${hex}' must be a hex RGB value such as #FF8800.`);
  return parseInt(match[1], 16);
}

/** Live snaps colors to its palette. True when the color Live chose differs from the one asked for. */
export function colorWasSnapped(requested: string | undefined, actual: unknown): boolean {
  if (requested === undefined) return false;
  return colorToHex(typeof actual === "string" ? hexToColor(actual) : actual) !== colorToHex(hexToColor(requested));
}

export function parseMixer(args: readonly unknown[]): MixerState {
  if (args.length < 3) throw new Error("Mixer reply is truncated.");
  const [kind, index, name] = args;
  if (kind !== "track" && kind !== "return" && kind !== "master") throw new Error(`Unexpected track kind '${String(kind)}'.`);
  const fields: Record<string, unknown> = {};
  const sends: SendState[] = [];
  let offset = 3;
  while (offset < args.length) {
    const key = args[offset];
    if (key === "send") {
      const display = String(args[offset + 3]);
      sends.push({ index: Number(args[offset + 1]), value: Number(args[offset + 2]), display, db: parseDb(display), returnName: args[offset + 4] === null ? null : String(args[offset + 4]) });
      offset += 5;
    } else {
      fields[String(key)] = args[offset + 1];
      offset += 2;
    }
  }
  const volumeDisplay = String(fields.volumeDisplay);
  return {
    trackKind: kind,
    trackIndex: Number(index),
    name: String(name),
    volume: Number(fields.volume),
    volumeDisplay,
    volumeDb: parseDb(volumeDisplay),
    pan: Number(fields.panning),
    panDisplay: String(fields.panningDisplay),
    mute: "mute" in fields ? fields.mute === true : null,
    solo: "solo" in fields ? fields.solo === true : null,
    canBeArmed: fields.canBeArmed === true,
    arm: "arm" in fields ? fields.arm === true : null,
    sends
  };
}

export function parsePairs(args: readonly unknown[], header: number): Record<string, unknown> {
  const body = args.slice(header);
  if (body.length % 2 !== 0) throw new Error("Reply is not key and value pairs.");
  const result: Record<string, unknown> = {};
  for (let offset = 0; offset < body.length; offset += 2) result[String(body[offset])] = body[offset + 1];
  return result;
}

export function parseScenes(args: readonly unknown[]): SceneState[] {
  const count = Number(args[0]);
  const fields = 8;
  if (!Number.isInteger(count) || args.length !== 1 + count * fields) throw new Error("Scene reply has the wrong length. Reinstall the Control Deck remote script and restart Live.");
  const scenes: SceneState[] = [];
  for (let index = 0; index < count; index++) {
    const base = 1 + index * fields;
    const [name, color, tempo, tempoEnabled, numerator, denominator, signatureEnabled, triggered] = args.slice(base, base + fields);
    scenes.push({
      index,
      name: String(name),
      color: colorToHex(color),
      tempo: typeof tempo === "number" && (tempoEnabled === true || (tempoEnabled == null && tempo > 0)) ? tempo : null,
      timeSignature: signatureEnabled === true || (signatureEnabled == null && Number(numerator) > 0) ? { numerator: Number(numerator), denominator: Number(denominator) } : null,
      triggered: triggered === true
    });
  }
  return scenes;
}

export function parsePlayback(args: readonly unknown[]): { tracks: TrackPlayback[]; triggeredScenes: number[] } {
  const trackCount = Number(args[0]);
  const tracks: TrackPlayback[] = [];
  for (let index = 0; index < trackCount; index++) {
    const base = 1 + index * 3;
    const playingSlotIndex = Math.max(-1, Number(args[base + 1]));
    const firedSlotIndex = Number(args[base + 2]);
    const state = firedSlotIndex === -2 ? "stopping" : firedSlotIndex >= 0 ? "queued" : playingSlotIndex >= 0 ? "playing" : "stopped";
    tracks.push({ trackIndex: index, name: String(args[base]), playingSlotIndex, firedSlotIndex, state });
  }
  const sceneStart = 1 + trackCount * 3;
  const sceneCount = Number(args[sceneStart]);
  const triggeredScenes: number[] = [];
  for (let index = 0; index < sceneCount; index++) if (args[sceneStart + 1 + index] === true) triggeredScenes.push(index);
  return { tracks, triggeredScenes };
}

export function parseRoutingOptions(args: readonly unknown[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let offset = 3;
  while (offset < args.length) {
    const label = String(args[offset]);
    const count = Number(args[offset + 1]);
    result[label] = args.slice(offset + 2, offset + 2 + count).map(String);
    offset += 2 + count;
  }
  return result;
}

function describeClip(kind: unknown, props: Record<string, unknown>) {
  const launchMode = typeof props.launch_mode === "number" ? LAUNCH_MODES[props.launch_mode] ?? props.launch_mode : null;
  const launchQuantization = typeof props.launch_quantization === "number" ? LAUNCH_QUANTIZATIONS[props.launch_quantization] ?? props.launch_quantization : null;
  const clip: Record<string, unknown> = {
    kind,
    name: props.name,
    color: colorToHex(props.color),
    lengthBeats: props.length,
    looping: props.looping,
    loopStart: props.loop_start,
    loopEnd: props.loop_end,
    startMarker: props.start_marker,
    endMarker: props.end_marker,
    launchMode,
    launchQuantization,
    legato: props.legato,
    muted: props.muted,
    isPlaying: props.is_playing
  };
  if (kind === "audio") {
    Object.assign(clip, {
      gain: props.gain,
      filePath: props.file_path ?? null,
      gainDisplay: props.gain_display,
      transposeSemitones: props.pitch_coarse,
      detuneCents: props.pitch_fine,
      warping: props.warping,
      warpMode: typeof props.warp_mode === "number" ? WARP_MODES[props.warp_mode] ?? props.warp_mode : null
    });
  }
  return clip;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function requireName(value: string, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
}

function trackArgs(kind: TrackKind, index: number): OscArgument[] {
  return [kind, oscInt(index)];
}

export interface TrackTarget { trackKind?: TrackKind; trackIndex: number; expectedTrackName: string }
export interface ClipTarget { trackIndex: number; sceneIndex: number; expectedTrackName: string; expectedClipName: string }

export class SessionTools {
  constructor(
    private readonly live: LiveControlClient,
    private readonly logger = new JsonLogger(),
    private readonly defaultDryRun = false,
    /** Looks up a sample id from search_samples and returns its path. */
    private readonly samplePathForId?: (id: number) => Promise<string>
  ) {}

  // ------------------------------------------------------------------ plumbing

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

  /** Check inputs and current state, then send one bridge command and verify it. Every failure is a ToolResult. */
  private async change<T, P>(tool: string, input: unknown, dryRun: boolean, prepare: () => Promise<{ address: string; args: OscArgument[]; before: P }>, verify: (before: P) => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    try {
      const { address, args, before } = await prepare();
      const operation = { address, args };
      if (dryRun || this.defaultDryRun) {
        await this.logger.write({ tool, args: input, liveOperation: operation, durationMs: performance.now() - started, success: true, dryRun: true });
        return { ok: true, dryRun: true, tool, intendedOperations: [operation] };
      }
      await this.live.send(address, args);
      const data = await verify(before);
      await this.logger.write({ tool, args: input, liveOperation: operation, response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool, data };
    } catch (error) { return this.fail(tool, started, error); }
  }

  private async poll<T>(fn: () => Promise<T>, done: (value: T) => boolean, attempts = POLL_ATTEMPTS): Promise<{ value: T; settled: boolean }> {
    let value = await fn();
    for (let attempt = 1; attempt < attempts && !done(value); attempt++) {
      await sleep(POLL_DELAY_MS);
      value = await fn();
    }
    return { value, settled: done(value) };
  }

  private async mixer(kind: TrackKind, index: number): Promise<MixerState> {
    return parseMixer((await this.live.query("/live/mixer/get", trackArgs(kind, index))).args);
  }

  private async trackNames(): Promise<string[]> {
    return (await this.live.query("/live/song/get/track_names")).args.map(String);
  }

  private async scenes(): Promise<SceneState[]> {
    return parseScenes((await this.live.query("/live/song/get/scenes")).args);
  }

  private async playback() {
    return parsePlayback((await this.live.query("/live/session/get/playback")).args);
  }

  private async slotState(trackIndex: number, sceneIndex: number) {
    const [, , hasClip, name, playing, triggered, recording] = (await this.live.query("/live/clip_slot/get/state", [oscInt(trackIndex), oscInt(sceneIndex)])).args;
    return { hasClip: hasClip === true, clipName: name === null ? null : String(name), playing: playing === true, triggered: triggered === true, recording: recording === true };
  }

  private async sessionNotes(trackIndex: number, sceneIndex: number): Promise<{ clipName: string; notes: ArrangementNote[] }> {
    const args = (await this.live.query("/live/session_clip/get/notes", [oscInt(trackIndex), oscInt(sceneIndex)])).args;
    if (args.length < 3 || args[0] !== trackIndex || args[1] !== sceneIndex) throw new Error(`Note reply was not addressed to track ${trackIndex}, scene ${sceneIndex}.`);
    return { clipName: String(args[2]), notes: parseNoteBody(args.slice(3), "Session") };
  }

  /** Return track names in order. Stops at the first index Live says does not exist; any other error is passed on. */
  private async returnNames(): Promise<string[]> {
    const names: string[] = [];
    for (let index = 0; index < 64; index++) {
      try { names.push((await this.mixer("return", index)).name); } catch (error) {
        if (/does not exist/.test(error instanceof Error ? error.message : String(error))) return names;
        throw error;
      }
    }
    return names;
  }

  private async clipProps(trackIndex: number, sceneIndex: number) {
    const args = (await this.live.query("/live/clip/get/properties", [oscInt(trackIndex), oscInt(sceneIndex)])).args;
    return { kind: args[2], props: parsePairs(args, 3) };
  }

  private async trackDetails(kind: TrackKind, index: number) {
    const args = (await this.live.query("/live/track/get/details", trackArgs(kind, index))).args;
    return { name: String(args[2]), props: parsePairs(args, 3) };
  }

  private requireTrackName(actual: string, expected: string, label = "track"): void {
    if (actual !== expected) throw new Error(`Track safeguard failed: expected ${label} '${expected}', found '${actual}'.`);
  }

  private async requireClip(target: ClipTarget) {
    nonNegativeInteger(target.trackIndex, "Track index");
    nonNegativeInteger(target.sceneIndex, "Scene index");
    requireName(target.expectedTrackName, "expectedTrackName");
    requireName(target.expectedClipName, "expectedClipName");
    const names = await this.trackNames();
    if (target.trackIndex >= names.length) throw new Error(`Track index ${target.trackIndex} does not exist.`);
    this.requireTrackName(names[target.trackIndex], target.expectedTrackName);
    const slot = await this.slotState(target.trackIndex, target.sceneIndex);
    if (!slot.hasClip) throw new Error(`No clip at track ${target.trackIndex}, scene ${target.sceneIndex}.`);
    if (slot.clipName !== target.expectedClipName) throw new Error(`Clip safeguard failed: expected '${target.expectedClipName}', found '${slot.clipName}'.`);
    return slot;
  }

  private clipArgs(target: ClipTarget): OscArgument[] {
    return [oscInt(target.trackIndex), oscInt(target.sceneIndex), target.expectedTrackName, target.expectedClipName];
  }

  private async requireScene(sceneIndex: number, expectedSceneName: string): Promise<SceneState[]> {
    nonNegativeInteger(sceneIndex, "Scene index");
    requireName(expectedSceneName, "expectedSceneName");
    const scenes = await this.scenes();
    const scene = scenes[sceneIndex];
    if (!scene) throw new Error(`Scene index ${sceneIndex} does not exist.`);
    if (scene.name !== expectedSceneName) throw new Error(`Scene safeguard failed: expected scene ${sceneIndex} to be '${expectedSceneName}', found '${scene.name}'.`);
    return scenes;
  }

  // ------------------------------------------------------------------ mixer

  getMixer(input: { trackKind?: TrackKind; trackIndex?: number } = {}): Promise<ToolResult> {
    return this.read("get_mixer", async () => {
      if (input.trackIndex !== undefined) {
        nonNegativeInteger(input.trackIndex, "Track index");
        return { tracks: [await this.mixer(input.trackKind ?? "track", input.trackIndex)] };
      }
      const names = await this.trackNames();
      const tracks: MixerState[] = [];
      for (let index = 0; index < names.length; index++) tracks.push(await this.mixer("track", index));
      const returns: MixerState[] = [];
      for (let index = 0; ; index++) {
        try { returns.push(await this.mixer("return", index)); } catch { break; }
      }
      return { tracks, returns, master: await this.mixer("master", 0) };
    });
  }

  setTrackMix(input: TrackTarget & {
    volumeDb?: number | "-inf"; volume?: number; pan?: number; mute?: boolean; solo?: boolean; arm?: boolean;
    sends?: Array<{ sendIndex: number; db?: number | "-inf"; value?: number }>; dryRun?: boolean;
  }): Promise<ToolResult> {
    const kind = input.trackKind ?? "track";
    return this.change("set_track_mix", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      if (input.volumeDb !== undefined && input.volume !== undefined) throw new Error("Pass volumeDb or volume, not both.");
      const changes: OscArgument[] = [];
      const add = (field: string, send: number, value: OscArgument) => changes.push(field, oscInt(send), value);
      if (input.volumeDb !== undefined) add("volume_db", NO_SEND, input.volumeDb === "-inf" ? "-inf" : oscFloat(input.volumeDb));
      if (input.volume !== undefined) add("volume", NO_SEND, oscFloat(input.volume));
      if (input.pan !== undefined) add("panning", NO_SEND, oscFloat(input.pan));
      if (input.mute !== undefined) add("mute", NO_SEND, input.mute);
      if (input.solo !== undefined) add("solo", NO_SEND, input.solo);
      if (input.arm !== undefined) add("arm", NO_SEND, input.arm);
      const seen = new Set<number>();
      for (const send of input.sends ?? []) {
        nonNegativeInteger(send.sendIndex, "Send index");
        if (seen.has(send.sendIndex)) throw new Error(`Send ${send.sendIndex} was given twice.`);
        seen.add(send.sendIndex);
        if ((send.db === undefined) === (send.value === undefined)) throw new Error(`Send ${send.sendIndex} needs exactly one of db or value.`);
        if (send.db !== undefined) add("send_db", send.sendIndex, send.db === "-inf" ? "-inf" : oscFloat(send.db));
        else add("send", send.sendIndex, oscFloat(send.value as number));
      }
      if (!changes.length) throw new Error("Nothing to change. Pass at least one of volumeDb, volume, pan, mute, solo, arm, or sends.");
      const before = await this.mixer(kind, input.trackIndex);
      this.requireTrackName(before.name, input.expectedTrackName, kind === "track" ? "track" : `${kind} track`);
      // The remote script refuses these too; checking here makes a dry run report them.
      if (kind === "master") for (const field of ["mute", "solo", "arm"] as const) if (input[field] !== undefined) throw new Error(`The master track has no ${field}.`);
      if (input.arm !== undefined && !before.canBeArmed) throw new Error(`Track '${before.name}' cannot be armed.`);
      if (typeof input.volumeDb === "number" && input.volumeDb > 6) throw new Error("Volume cannot go above 6 dB.");
      for (const send of input.sends ?? []) {
        if (kind === "master") throw new Error("The master track has no sends.");
        if (kind === "return" && send.sendIndex === input.trackIndex) throw new Error(`Return track '${before.name}' cannot send to itself.`);
        if (send.sendIndex >= before.sends.length) throw new Error(`Send ${send.sendIndex} does not exist; this set has ${before.sends.length} return track(s).`);
        if (typeof send.db === "number" && send.db > 0) throw new Error(`Send ${send.sendIndex} cannot go above 0 dB.`);
      }
      return { address: "/live/mixer/set", args: [...trackArgs(kind, input.trackIndex), input.expectedTrackName, ...changes], before };
    }, async before => {
      const after = await this.mixer(kind, input.trackIndex);
      const problems: string[] = [];
      const checkDb = (label: string, wanted: number | "-inf", display: string) => {
        const actual = parseDb(display);
        const ok = wanted === "-inf" ? actual === -Infinity : actual !== null && Math.abs(actual - wanted) <= DB_TOLERANCE;
        if (!ok) problems.push(`${label} reads ${display}, not ${wanted === "-inf" ? "-inf" : wanted} dB`);
      };
      if (input.volumeDb !== undefined) checkDb("Volume", input.volumeDb, after.volumeDisplay);
      if (input.volume !== undefined && Math.abs(after.volume - input.volume) > VALUE_TOLERANCE) problems.push(`Volume is ${after.volume}, not ${input.volume}`);
      if (input.pan !== undefined && Math.abs(after.pan - input.pan) > VALUE_TOLERANCE) problems.push(`Pan is ${after.pan}, not ${input.pan}`);
      if (input.mute !== undefined && after.mute !== input.mute) problems.push(`Mute is ${after.mute}`);
      if (input.solo !== undefined && after.solo !== input.solo) problems.push(`Solo is ${after.solo}`);
      if (input.arm !== undefined && after.arm !== input.arm) problems.push(`Arm is ${after.arm}`);
      for (const send of input.sends ?? []) {
        const actual = after.sends[send.sendIndex];
        if (!actual) { problems.push(`Send ${send.sendIndex} is missing after the change`); continue; }
        if (send.db !== undefined) checkDb(`Send ${send.sendIndex}`, send.db, actual.display);
        else if (Math.abs(actual.value - (send.value as number)) > VALUE_TOLERANCE) problems.push(`Send ${send.sendIndex} is ${actual.value}, not ${send.value}`);
      }
      if (problems.length) throw new Error(`Mixer verification failed: ${problems.join("; ")}.`);
      return { before, after };
    });
  }

  // ------------------------------------------------------------------ launching

  getSessionPlayback(): Promise<ToolResult> {
    return this.read("get_session_playback", async () => this.playback());
  }

  fireClip(input: ClipTarget & { dryRun?: boolean }): Promise<ToolResult> {
    return this.change("fire_clip", input, input.dryRun ?? false, async () => {
      await this.requireClip(input);
      return { address: "/live/clip_slot/fire", args: this.clipArgs(input), before: null };
    }, async () => {
      const { value, settled } = await this.poll(() => this.slotState(input.trackIndex, input.sceneIndex), slot => slot.playing || slot.triggered);
      if (!settled) throw new Error("Live did not queue or play the clip after firing it.");
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, clipName: value.clipName, state: value.playing ? "playing" : "queued" };
    });
  }

  stopTrackClips(input: { trackIndex: number; expectedTrackName: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("stop_track_clips", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      const names = await this.trackNames();
      if (input.trackIndex >= names.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
      this.requireTrackName(names[input.trackIndex], input.expectedTrackName);
      return { address: "/live/track/stop_clips", args: [oscInt(input.trackIndex), input.expectedTrackName], before: null };
    }, async () => {
      const { value, settled } = await this.poll(() => this.playback(), state => ["stopped", "stopping"].includes(state.tracks[input.trackIndex]?.state));
      if (!settled) throw new Error(`Track ${input.trackIndex} is still ${value.tracks[input.trackIndex]?.state} after stopping its clips.`);
      return value.tracks[input.trackIndex];
    });
  }

  fireScene(input: { sceneIndex: number; expectedSceneName: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("fire_scene", input, input.dryRun ?? false, async () => {
      await this.requireScene(input.sceneIndex, input.expectedSceneName);
      return { address: "/live/scene/fire", args: [oscInt(input.sceneIndex), input.expectedSceneName], before: null };
    }, async () => {
      const launched = (state: Awaited<ReturnType<SessionTools["playback"]>>) =>
        state.triggeredScenes.includes(input.sceneIndex) || state.tracks.some(track => track.firedSlotIndex === input.sceneIndex || track.playingSlotIndex === input.sceneIndex);
      const { value, settled } = await this.poll(() => this.playback(), launched);
      // A scene with no clips launches nothing a read-back can see, so report it rather than fail.
      return {
        sceneIndex: input.sceneIndex,
        sceneName: input.expectedSceneName,
        confirmed: settled,
        tracks: value.tracks.filter(track => track.firedSlotIndex === input.sceneIndex || track.playingSlotIndex === input.sceneIndex),
        note: settled ? undefined : "Live accepted the launch, but no track shows a clip from this scene queued or playing. The scene may have no clips."
      };
    });
  }

  stopAllClips(input: { quantized?: boolean; dryRun?: boolean } = {}): Promise<ToolResult> {
    const quantized = input.quantized ?? true;
    return this.change("stop_all_clips", input, input.dryRun ?? false, async () => ({ address: "/live/song/stop_all_clips", args: [quantized], before: null }), async () => {
      const { value, settled } = await this.poll(() => this.playback(), state => state.tracks.every(track => track.state === "stopped" || track.state === "stopping"));
      if (!settled) throw new Error(`Some tracks are still playing: ${value.tracks.filter(track => track.state === "playing" || track.state === "queued").map(track => track.name).join(", ")}.`);
      return { quantized, tracks: value.tracks };
    });
  }

  // ------------------------------------------------------------------ scenes

  listScenes(): Promise<ToolResult> {
    return this.read("list_scenes", async () => {
      try {
        return { scenes: await this.scenes() };
      } catch (error) {
        // A remote script from before scene details only lists names.
        if (!/Unsupported (Live|song) query/.test(error instanceof Error ? error.message : String(error))) throw error;
        const names = (await this.live.query("/live/song/get/scenes/name")).args;
        return { scenes: names.map((name, index) => ({ index, name: String(name) })), note: "The installed remote script is older than this server, so only scene names are listed. Run `npm run setup` and restart Live." };
      }
    });
  }

  createScene(input: { index?: number; name?: string; dryRun?: boolean }): Promise<ToolResult> {
    const index = input.index ?? -1;
    return this.change("create_scene", input, input.dryRun ?? false, async () => {
      if (!Number.isInteger(index) || index < -1) throw new Error("Scene index must be -1 (append) or a non-negative integer.");
      const before = await this.scenes();
      if (index > before.length) throw new Error(`Scene index ${index} is past the end; this set has ${before.length} scenes.`);
      return { address: "/live/song/create_scene", args: [oscInt(index), input.name ?? null] as OscArgument[], before };
    }, async before => {
      const after = await this.scenes();
      if (after.length !== before.length + 1) throw new Error(`Scene count is ${after.length}, expected ${before.length + 1}.`);
      const created = after[index === -1 ? before.length : index];
      if (input.name !== undefined && created.name !== cleanName(input.name)) throw new Error(`New scene is named '${created.name}', not '${input.name}'.`);
      return { created, sceneCount: after.length };
    });
  }

  duplicateScene(input: { sceneIndex: number; expectedSceneName: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("duplicate_scene", input, input.dryRun ?? false, async () => {
      const before = await this.requireScene(input.sceneIndex, input.expectedSceneName);
      return { address: "/live/song/duplicate_scene", args: [oscInt(input.sceneIndex), input.expectedSceneName], before };
    }, async before => {
      const after = await this.scenes();
      if (after.length !== before.length + 1) throw new Error(`Scene count is ${after.length}, expected ${before.length + 1}.`);
      return { source: after[input.sceneIndex], duplicate: after[input.sceneIndex + 1], sceneCount: after.length };
    });
  }

  deleteScene(input: { sceneIndex: number; expectedSceneName: string; confirm: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("delete_scene", input, input.dryRun ?? false, async () => {
      if (input.confirm !== true && !(input.dryRun ?? false)) throw new Error("delete_scene requires confirm=true.");
      const before = await this.requireScene(input.sceneIndex, input.expectedSceneName);
      if (before.length <= 1) throw new Error("Live needs at least one scene, so the last scene cannot be deleted.");
      return { address: "/live/song/delete_scene", args: [oscInt(input.sceneIndex), input.expectedSceneName, input.confirm === true], before };
    }, async before => {
      const after = await this.scenes();
      if (after.length !== before.length - 1) throw new Error(`Scene count is ${after.length}, expected ${before.length - 1}.`);
      return { deleted: before[input.sceneIndex], sceneCount: after.length };
    });
  }

  setScene(input: { sceneIndex: number; expectedSceneName: string; name?: string; color?: string; tempo?: number | null; timeSignature?: { numerator: number; denominator: number } | null; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("set_scene", input, input.dryRun ?? false, async () => {
      const changes: OscArgument[] = [];
      if (input.name !== undefined) changes.push("name", input.name, null);
      if (input.color !== undefined) changes.push("color", oscInt(hexToColor(input.color)), null);
      if (input.tempo !== undefined) changes.push("tempo", input.tempo === null ? null : oscFloat(input.tempo), null);
      if (input.timeSignature !== undefined) {
        if (input.timeSignature === null) changes.push("signature", null, null);
        else changes.push("signature", oscInt(input.timeSignature.numerator), oscInt(input.timeSignature.denominator));
      }
      if (!changes.length) throw new Error("Nothing to change. Pass at least one of name, color, tempo, or timeSignature.");
      const before = await this.requireScene(input.sceneIndex, input.expectedSceneName);
      return { address: "/live/scene/set", args: [oscInt(input.sceneIndex), input.expectedSceneName, ...changes], before: before[input.sceneIndex] };
    }, async before => {
      const after = (await this.scenes())[input.sceneIndex];
      const problems: string[] = [];
      if (input.name !== undefined && after.name !== cleanName(input.name)) problems.push(`name is '${after.name}'`);
      if (input.tempo !== undefined && (input.tempo === null ? after.tempo !== null : after.tempo === null || Math.abs(after.tempo - input.tempo) > TIME_TOLERANCE)) problems.push(`tempo is ${after.tempo}`);
      if (input.timeSignature !== undefined) {
        const wanted = input.timeSignature;
        const actual = after.timeSignature;
        if (wanted === null ? actual !== null : actual?.numerator !== wanted.numerator || actual?.denominator !== wanted.denominator) problems.push(`time signature is ${actual ? `${actual.numerator}/${actual.denominator}` : "off"}`);
      }
      if (problems.length) throw new Error(`Scene verification failed: ${problems.join("; ")}.`);
      // Live snaps colors to its palette, so report the color it chose.
      return { before, after, ...(input.color !== undefined ? { colorSnapped: colorWasSnapped(input.color, after.color) } : {}) };
    });
  }

  // ------------------------------------------------------------------ clips

  getClip(input: { trackIndex: number; sceneIndex: number }): Promise<ToolResult> {
    return this.read("get_clip", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      const { kind, props } = await this.clipProps(input.trackIndex, input.sceneIndex);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, ...describeClip(kind, props) };
    });
  }

  setClip(input: ClipTarget & {
    name?: string; color?: string; looping?: boolean; loopStart?: number; loopEnd?: number; startMarker?: number; endMarker?: number;
    launchMode?: LaunchMode; launchQuantization?: LaunchQuantization; legato?: boolean; muted?: boolean;
    gain?: number; transposeSemitones?: number; detuneCents?: number; warping?: boolean; warpMode?: WarpMode; dryRun?: boolean;
  }): Promise<ToolResult> {
    const requested: Array<[string, OscArgument, unknown]> = [];
    return this.change("set_clip", input, input.dryRun ?? false, async () => {
      const push = (field: string, value: OscArgument, expected: unknown) => requested.push([field, value, expected]);
      const pick = <T extends string>(list: readonly T[], value: T | undefined, label: string) => {
        if (value !== undefined && !list.includes(value)) throw new Error(`${label} '${value}' is not one of: ${list.join(", ")}.`);
      };
      pick(LAUNCH_MODES, input.launchMode, "Launch mode");
      pick(LAUNCH_QUANTIZATIONS, input.launchQuantization, "Launch quantization");
      pick(WARP_MODES, input.warpMode, "Warp mode");
      if (input.name !== undefined) push("name", input.name, cleanName(input.name));
      if (input.color !== undefined) push("color", oscInt(hexToColor(input.color)), undefined);
      if (input.looping !== undefined) push("looping", input.looping, input.looping);
      if (input.loopStart !== undefined) push("loop_start", oscFloat(input.loopStart), input.loopStart);
      if (input.loopEnd !== undefined) push("loop_end", oscFloat(input.loopEnd), input.loopEnd);
      if (input.startMarker !== undefined) push("start_marker", oscFloat(input.startMarker), input.startMarker);
      if (input.endMarker !== undefined) push("end_marker", oscFloat(input.endMarker), input.endMarker);
      if (input.launchMode !== undefined) push("launch_mode", oscInt(LAUNCH_MODES.indexOf(input.launchMode)), LAUNCH_MODES.indexOf(input.launchMode));
      if (input.launchQuantization !== undefined) push("launch_quantization", oscInt(LAUNCH_QUANTIZATIONS.indexOf(input.launchQuantization)), LAUNCH_QUANTIZATIONS.indexOf(input.launchQuantization));
      if (input.legato !== undefined) push("legato", input.legato, input.legato);
      if (input.muted !== undefined) push("muted", input.muted, input.muted);
      if (input.gain !== undefined) push("gain", oscFloat(input.gain), input.gain);
      if (input.transposeSemitones !== undefined) push("pitch_coarse", oscInt(input.transposeSemitones), input.transposeSemitones);
      if (input.detuneCents !== undefined) push("pitch_fine", oscFloat(input.detuneCents), input.detuneCents);
      if (input.warping !== undefined) push("warping", input.warping, input.warping);
      if (input.warpMode !== undefined) push("warp_mode", oscInt(WARP_MODES.indexOf(input.warpMode)), WARP_MODES.indexOf(input.warpMode));
      if (!requested.length) throw new Error("Nothing to change. Pass at least one clip property.");
      await this.requireClip(input);
      const before = await this.clipProps(input.trackIndex, input.sceneIndex);
      const audioOnly = requested.map(([field]) => field).filter(field => ["gain", "pitch_coarse", "pitch_fine", "warping", "warp_mode"].includes(field));
      if (audioOnly.length && before.kind !== "audio") throw new Error(`${audioOnly.join(", ")} ${audioOnly.length === 1 ? "applies" : "apply"} only to audio clips; this clip is ${String(before.kind)}.`);
      return { address: "/live/clip/set", args: [...this.clipArgs(input), ...requested.flatMap(([field, value]) => [field, value])], before };
    }, async before => {
      const after = await this.clipProps(input.trackIndex, input.sceneIndex);
      const problems: string[] = [];
      for (const [field, , expected] of requested) {
        if (expected === undefined) continue;
        const actual = after.props[field];
        const same = typeof expected === "number" ? typeof actual === "number" && Math.abs(actual - expected) <= TIME_TOLERANCE : actual === expected;
        if (!same) problems.push(`${field} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
      }
      if (problems.length) throw new Error(`Clip verification failed: ${problems.join("; ")}.`);
      // Live can change settings that were not asked for: turning warping off also turns looping off and moves the markers.
      const asked = new Set(requested.map(([field]) => field));
      if (asked.has("gain")) asked.add("gain_display");
      // Length follows the loop and markers, so it is expected to change with them.
      if (["looping", "loop_start", "loop_end", "start_marker", "end_marker"].some(field => asked.has(field))) asked.add("length");
      const alsoChangedByLive = Object.keys(after.props).filter(field => !asked.has(field) && field !== "is_playing" && field !== "is_triggered" && JSON.stringify(after.props[field]) !== JSON.stringify(before.props[field]));
      return {
        before: describeClip(before.kind, before.props),
        after: describeClip(after.kind, after.props),
        ...(input.color !== undefined ? { colorSnapped: colorWasSnapped(input.color, after.props.color) } : {}),
        ...(alsoChangedByLive.length ? { alsoChangedByLive, note: `Live also changed ${alsoChangedByLive.join(", ")}. Check ${alsoChangedByLive.length === 1 ? "it" : "them"} before continuing.` } : {})
      };
    });
  }

  duplicateClip(input: ClipTarget & { targetTrackIndex: number; targetSceneIndex: number; expectedTargetTrackName: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("duplicate_clip", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.targetTrackIndex, "Target track index");
      nonNegativeInteger(input.targetSceneIndex, "Target scene index");
      await this.requireClip(input);
      const names = await this.trackNames();
      if (input.targetTrackIndex >= names.length) throw new Error(`Target track index ${input.targetTrackIndex} does not exist.`);
      this.requireTrackName(names[input.targetTrackIndex], input.expectedTargetTrackName, "target track");
      const target = await this.slotState(input.targetTrackIndex, input.targetSceneIndex);
      if (target.hasClip) throw new Error(`Target slot already holds clip '${target.clipName}'. Delete it first.`);
      return { address: "/live/clip_slot/duplicate_to", args: [...this.clipArgs(input), oscInt(input.targetTrackIndex), oscInt(input.targetSceneIndex), input.expectedTargetTrackName], before: null };
    }, async () => {
      const target = await this.slotState(input.targetTrackIndex, input.targetSceneIndex);
      if (!target.hasClip || target.clipName !== input.expectedClipName) throw new Error(`Duplicate verification failed: target slot holds ${target.hasClip ? `'${target.clipName}'` : "no clip"}.`);
      return { trackIndex: input.targetTrackIndex, sceneIndex: input.targetSceneIndex, clipName: target.clipName };
    });
  }

  deleteClip(input: ClipTarget & { confirm: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("delete_clip", input, input.dryRun ?? false, async () => {
      if (input.confirm !== true && !(input.dryRun ?? false)) throw new Error("delete_clip requires confirm=true.");
      await this.requireClip(input);
      return { address: "/live/clip_slot/delete_clip", args: [...this.clipArgs(input), input.confirm === true], before: null };
    }, async () => {
      const slot = await this.slotState(input.trackIndex, input.sceneIndex);
      if (slot.hasClip) throw new Error(`Delete verification failed: the slot still holds '${slot.clipName}'.`);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, deleted: input.expectedClipName };
    });
  }

  // ------------------------------------------------------------------ undo

  private async undoState() {
    const [canUndo, canRedo] = (await this.live.query("/live/song/get/undo_state")).args;
    return { canUndo: canUndo === true, canRedo: canRedo === true };
  }

  getUndoState(): Promise<ToolResult> {
    return this.read("get_undo_state", () => this.undoState());
  }

  undo(dryRun = false): Promise<ToolResult> {
    return this.history("undo", dryRun);
  }

  redo(dryRun = false): Promise<ToolResult> {
    return this.history("redo", dryRun);
  }

  private history(direction: "undo" | "redo", dryRun: boolean): Promise<ToolResult> {
    return this.change(direction, { dryRun }, dryRun, async () => {
      const before = await this.undoState();
      if (direction === "undo" ? !before.canUndo : !before.canRedo) throw new Error(`Live has nothing to ${direction}.`);
      return { address: `/live/song/${direction}`, args: [], before };
    }, async before => {
      const after = await this.undoState();
      if (direction === "undo" && !after.canRedo) throw new Error("Undo verification failed: Live has nothing to redo afterwards.");
      return {
        before, after,
        note: `Live ${direction === "undo" ? "undid" : "redid"} its most recent step. That step may be a change made by hand in Live, not by Control Deck. Read back the affected state to see what changed.`
      };
    });
  }

  // ------------------------------------------------------------------ tracks

  getTrackRouting(input: { trackKind?: TrackKind; trackIndex: number }): Promise<ToolResult> {
    const kind = input.trackKind ?? "track";
    return this.read("get_track_routing", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      const [details, options] = await Promise.all([
        this.trackDetails(kind, input.trackIndex),
        this.live.query("/live/track/get/routing_options", trackArgs(kind, input.trackIndex)).then(reply => parseRoutingOptions(reply.args))
      ]);
      const p = details.props;
      return {
        trackKind: kind, trackIndex: input.trackIndex, name: details.name,
        current: { inputType: p.input_routing_type, inputChannel: p.input_routing_channel, outputType: p.output_routing_type, outputChannel: p.output_routing_channel },
        options: { inputTypes: options.input_routing_type, inputChannels: options.input_routing_channel, outputTypes: options.output_routing_type, outputChannels: options.output_routing_channel }
      };
    });
  }

  setTrack(input: TrackTarget & { color?: string; folded?: boolean; inputType?: string; inputChannel?: string; outputType?: string; outputChannel?: string; dryRun?: boolean }): Promise<ToolResult> {
    const kind = input.trackKind ?? "track";
    const fields: Array<[string, OscArgument, string | boolean | undefined]> = [];
    return this.change("set_track", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      if (input.color !== undefined) fields.push(["color", oscInt(hexToColor(input.color)), undefined]);
      if (input.folded !== undefined) fields.push(["folded", input.folded, input.folded]);
      if (input.inputType !== undefined) fields.push(["input_routing_type", input.inputType, input.inputType]);
      if (input.inputChannel !== undefined) fields.push(["input_routing_channel", input.inputChannel, input.inputChannel]);
      if (input.outputType !== undefined) fields.push(["output_routing_type", input.outputType, input.outputType]);
      if (input.outputChannel !== undefined) fields.push(["output_routing_channel", input.outputChannel, input.outputChannel]);
      if (!fields.length) throw new Error("Nothing to change. Pass at least one of color, folded, inputType, inputChannel, outputType, or outputChannel.");
      const before = await this.trackDetails(kind, input.trackIndex);
      this.requireTrackName(before.name, input.expectedTrackName, kind === "track" ? "track" : `${kind} track`);
      return { address: "/live/track/set", args: [...trackArgs(kind, input.trackIndex), input.expectedTrackName, ...fields.flatMap(([field, value]) => [field, value])], before };
    }, async before => {
      const after = await this.trackDetails(kind, input.trackIndex);
      const problems = fields.filter(([field, , expected]) => expected !== undefined && after.props[field] !== expected).map(([field]) => `${field} is ${JSON.stringify(after.props[field])}`);
      if (problems.length) throw new Error(`Track verification failed: ${problems.join("; ")}.`);
      const summary = (details: typeof before) => ({ name: details.name, color: colorToHex(details.props.color), folded: details.props.folded, inputType: details.props.input_routing_type, inputChannel: details.props.input_routing_channel, outputType: details.props.output_routing_type, outputChannel: details.props.output_routing_channel });
      return { before: summary(before), after: summary(after), ...(input.color !== undefined ? { colorSnapped: colorWasSnapped(input.color, after.props.color) } : {}) };
    });
  }

  duplicateTrack(input: { trackIndex: number; expectedTrackName: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("duplicate_track", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      const before = await this.trackNames();
      if (input.trackIndex >= before.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
      this.requireTrackName(before[input.trackIndex], input.expectedTrackName);
      return { address: "/live/song/duplicate_track", args: [oscInt(input.trackIndex), input.expectedTrackName], before };
    }, async before => {
      const after = await this.trackNames();
      if (after.length !== before.length + 1) throw new Error(`Track count is ${after.length}, expected ${before.length + 1}.`);
      return { source: { index: input.trackIndex, name: after[input.trackIndex] }, duplicate: { index: input.trackIndex + 1, name: after[input.trackIndex + 1] }, trackCount: after.length };
    });
  }

  // ------------------------------------------------------------------ session clip notes

  getClipNotes(input: { trackIndex: number; sceneIndex: number }): Promise<ToolResult> {
    return this.read("get_clip_notes", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      const { clipName, notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, clipName, noteCount: notes.length, notes };
    });
  }

  modifyClipNotes(input: ClipTarget & { notes: Array<{ noteId: number; pitch?: number | string; startTime?: number; duration?: number; velocity?: number; mute?: boolean }>; dryRun?: boolean }): Promise<ToolResult> {
    let desired: ArrangementNote[] = [];
    return this.change("modify_clip_notes", input, input.dryRun ?? false, async () => {
      if (!Array.isArray(input.notes) || input.notes.length === 0) throw new Error("At least one note modification is required.");
      if (input.notes.length > MAX_NOTES_PER_CALL) throw new Error(`At most ${MAX_NOTES_PER_CALL} notes can be modified at once.`);
      const seen = new Set<number>();
      for (const note of input.notes) {
        if (!Number.isInteger(note.noteId) || note.noteId < 0) throw new Error("noteId must be a non-negative integer.");
        if (seen.has(note.noteId)) throw new Error(`Note id ${note.noteId} was given more than once.`);
        seen.add(note.noteId);
        if (note.pitch === undefined && note.startTime === undefined && note.duration === undefined && note.velocity === undefined && note.mute === undefined) throw new Error(`Note id ${note.noteId} has no fields to change.`);
      }
      await this.requireClip(input);
      const current = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      const byId = new Map(current.notes.map(note => [note.noteId, note]));
      if (byId.size !== current.notes.length) throw new Error("The clip has duplicate note ids; refusing to modify.");
      desired = input.notes.map(change => {
        const existing = byId.get(change.noteId);
        if (!existing) throw new Error(`No note with id ${change.noteId} in the clip at track ${input.trackIndex}, scene ${input.sceneIndex}. Read ids with get_clip_notes.`);
        const pitch = change.pitch === undefined ? existing.pitch : typeof change.pitch === "string" ? noteNameToMidi(change.pitch) : change.pitch;
        const velocity = change.velocity === undefined ? Math.round(existing.velocity) : change.velocity;
        const next = { noteId: change.noteId, pitch, startTime: change.startTime ?? existing.startTime, duration: change.duration ?? existing.duration, velocity, mute: change.mute ?? existing.mute };
        assertOutgoingNote(next, change.velocity === undefined ? 0 : 1);
        return next;
      });
      const args = this.clipArgs(input);
      for (const note of desired) args.push(oscInt(note.noteId), oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(note.velocity), note.mute);
      return { address: "/live/session_clip/modify/notes", args, before: null };
    }, async () => {
      const { notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      verifyModifiedNotes(desired, notes);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, noteCountModified: desired.length, noteCountInClip: notes.length, notes };
    });
  }

  removeClipNotes(input: ClipTarget & { fromPitch: number; pitchSpan: number; fromTime: number; timeSpan: number; dryRun?: boolean }): Promise<ToolResult> {
    const { fromPitch, pitchSpan, fromTime, timeSpan } = input;
    return this.change("remove_clip_notes", input, input.dryRun ?? false, async () => {
      if (!Number.isInteger(fromPitch) || fromPitch < 0 || fromPitch > 127 || !Number.isInteger(pitchSpan) || pitchSpan < 1 || fromPitch + pitchSpan > 128) throw new Error("Pitch range must stay inside MIDI pitches 0-127.");
      if (!Number.isFinite(fromTime) || fromTime < 0 || !Number.isFinite(timeSpan) || timeSpan <= 0) throw new Error("fromTime must be >= 0 and timeSpan must be positive. Times are beats from the start of the clip.");
      await this.requireClip(input);
      const before = (await this.sessionNotes(input.trackIndex, input.sceneIndex)).notes;
      const targets = notesStartingInRange(before, { fromPitch, pitchSpan, fromTime, timeSpan });
      if (!targets.length) throw new Error("No notes start in that pitch and time range.");
      return { address: "/live/session_clip/remove/notes", args: [...this.clipArgs(input), oscInt(fromPitch), oscInt(pitchSpan), oscFloat(fromTime), oscFloat(timeSpan)], before: { before, targets } };
    }, async ({ before, targets }) => {
      const { notes } = await this.sessionNotes(input.trackIndex, input.sceneIndex);
      const removedNoteIds = targets.map(note => note.noteId);
      verifyRemovedNotes(before, removedNoteIds, notes);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, removedNoteIds, removedCount: targets.length, noteCountInClip: notes.length, notes };
    });
  }

  // ------------------------------------------------------------------ return tracks

  createReturnTrack(input: { name?: string; dryRun?: boolean } = {}): Promise<ToolResult> {
    return this.change("create_return_track", input, input.dryRun ?? false, async () => {
      const before = await this.returnNames();
      if (before.length >= 12) throw new Error("Live allows at most 12 return tracks.");
      if (input.name !== undefined && (!cleanName(input.name) || cleanName(input.name).length > 128)) throw new Error("Return track name must be 1-128 characters.");
      return { address: "/live/song/create_return_track", args: input.name === undefined ? [] : [input.name], before };
    }, async before => {
      const { value: after, settled } = await this.poll(() => this.returnNames(), names => names.length === before.length + 1);
      if (!settled) throw new Error(`Return track count is ${after.length}, expected ${before.length + 1}.`);
      const created = { trackKind: "return" as const, trackIndex: after.length - 1, name: after[after.length - 1] };
      // Live reports a return track's name with its letter, so "Plate" reads back as "C-Plate".
      if (input.name !== undefined && created.name.replace(/^[A-Z]-/, "") !== cleanName(input.name)) throw new Error(`New return track is named '${created.name}', not '${cleanName(input.name)}'.`);
      return { created, returnTracks: after, note: "Every track now has a send to this return, starting at -inf dB." };
    });
  }

  deleteReturnTrack(input: { trackIndex: number; expectedTrackName: string; confirm: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("delete_return_track", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Return track index");
      if (input.confirm !== true && !(input.dryRun ?? false)) throw new Error("delete_return_track requires confirm=true.");
      const before = await this.returnNames();
      if (input.trackIndex >= before.length) throw new Error(`Return track index ${input.trackIndex} does not exist; this set has ${before.length}.`);
      this.requireTrackName(before[input.trackIndex], input.expectedTrackName, "return track");
      return { address: "/live/song/delete_return_track", args: [oscInt(input.trackIndex), input.expectedTrackName, input.confirm === true], before };
    }, async before => {
      const { value: after, settled } = await this.poll(() => this.returnNames(), names => names.length === before.length - 1);
      if (!settled) throw new Error(`Return track count is ${after.length}, expected ${before.length - 1}.`);
      return { deleted: { trackIndex: input.trackIndex, name: before[input.trackIndex] }, returnTracks: after, note: "Every track lost its send to this return. Live renames the remaining returns' letters." };
    });
  }


  // ------------------------------------------------------------------ samples

  /** Resolve a sample id or path to the real path of an existing audio file. */
  private async samplePath(input: { sampleId?: number; path?: string }): Promise<string> {
    if ((input.sampleId === undefined) === (input.path === undefined)) throw new Error("Pass exactly one of sampleId (from search_samples) or path.");
    let path = input.path;
    if (input.sampleId !== undefined) {
      if (!this.samplePathForId) throw new Error("The sample index is not available here; pass a path instead.");
      path = await this.samplePathForId(input.sampleId);
    }
    if (!path || path.includes("\0") || !isAbsolute(path)) throw new Error("Sample path must be absolute.");
    const extension = extname(path).toLowerCase();
    if (!SAMPLE_EXTENSIONS.includes(extension)) throw new Error(`Sample must be one of: ${SAMPLE_EXTENSIONS.join(", ")}.`);
    let real: string;
    try { real = await realpath(path); } catch { throw new Error(`No file at ${path}.`); }
    if (!(await stat(real)).isFile()) throw new Error(`${path} is not a file.`);
    if (!SAMPLE_EXTENSIONS.includes(extname(real).toLowerCase())) throw new Error(`${path} points to a file that is not audio.`);
    return real;
  }

  /** Live names an untitled track after its first clip or device, so report the name the next call must use. */
  private async trackNameAfter(trackIndex: number, nameBefore: string): Promise<{ trackName: string; note?: string }> {
    const trackName = (await this.trackNames())[trackIndex];
    return trackName === nameBefore ? { trackName } : { trackName, note: `Live renamed the track from '${nameBefore}' to '${trackName}'. Use the new name in later calls.` };
  }

  private async arrangementClips(trackIndex: number): Promise<ArrangementClipDescriptor[]> {
    return parseArrangementClips((await this.live.query("/live/track/get/arrangement_clips", [oscInt(trackIndex)])).args, trackIndex);
  }

  loadSampleToClipSlot(input: { trackIndex: number; sceneIndex: number; expectedTrackName: string; sampleId?: number; path?: string; clipName?: string; dryRun?: boolean }): Promise<ToolResult> {
    let path = "";
    return this.change("load_sample_to_clip_slot", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      if (input.clipName !== undefined && !cleanName(input.clipName)) throw new Error("clipName must contain more than spaces.");
      path = await this.samplePath(input);
      const names = await this.trackNames();
      if (input.trackIndex >= names.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
      this.requireTrackName(names[input.trackIndex], input.expectedTrackName);
      const slot = await this.slotState(input.trackIndex, input.sceneIndex);
      if (slot.hasClip) throw new Error(`Track ${input.trackIndex}, scene ${input.sceneIndex} already holds clip '${slot.clipName}'. Delete it first.`);
      const args: OscArgument[] = [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, path];
      if (input.clipName !== undefined) args.push(input.clipName);
      return { address: "/live/clip_slot/load_sample", args, before: null };
    }, async () => {
      const { value: slot, settled } = await this.poll(() => this.slotState(input.trackIndex, input.sceneIndex), state => state.hasClip, SAMPLE_POLL_ATTEMPTS);
      if (!settled || !slot.hasClip) throw new Error("Live did not show the audio clip within 6 seconds. Check the slot before retrying; the load may still finish.");
      const clip = await this.clipProps(input.trackIndex, input.sceneIndex);
      if (clip.kind !== "audio") throw new Error(`The new clip is ${String(clip.kind)}, not audio.`);
      if (clip.props.file_path !== undefined && clip.props.file_path !== path) throw new Error(`The new clip plays ${String(clip.props.file_path)}, not ${path}.`);
      if (input.clipName !== undefined && clip.props.name !== cleanName(input.clipName)) throw new Error(`The new clip is named '${String(clip.props.name)}', not '${cleanName(input.clipName)}'.`);
      return { trackIndex: input.trackIndex, sceneIndex: input.sceneIndex, ...(await this.trackNameAfter(input.trackIndex, input.expectedTrackName)), file: path, clip: describeClip(clip.kind, clip.props) };
    });
  }

  loadSampleToArrangement(input: { trackIndex: number; expectedTrackName: string; startBeats: number; sampleId?: number; path?: string; dryRun?: boolean }): Promise<ToolResult> {
    let path = "";
    return this.change("load_sample_to_arrangement", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      if (!Number.isFinite(input.startBeats) || input.startBeats < 0 || input.startBeats > MAX_ARRANGEMENT_BEATS) throw new Error(`startBeats must be from 0 to ${MAX_ARRANGEMENT_BEATS}.`);
      path = await this.samplePath(input);
      const names = await this.trackNames();
      if (input.trackIndex >= names.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
      this.requireTrackName(names[input.trackIndex], input.expectedTrackName);
      const before = await this.arrangementClips(input.trackIndex);
      const covering = before.find(clip => clip.startBeats <= input.startBeats + TIME_TOLERANCE && clip.endBeats > input.startBeats + TIME_TOLERANCE);
      if (covering) throw new Error(`Clip '${covering.name}' already covers beat ${input.startBeats} (${covering.startBeats}-${covering.endBeats}).`);
      return { address: "/live/track/load_sample_to_arrangement", args: [oscInt(input.trackIndex), input.expectedTrackName, path, oscFloat(input.startBeats)], before };
    }, async before => {
      const same = (left: ArrangementClipDescriptor, right: ArrangementClipDescriptor) => Math.abs(left.startBeats - right.startBeats) <= TIME_TOLERANCE && Math.abs(left.endBeats - right.endBeats) <= TIME_TOLERANCE && left.name === right.name;
      // Wait for the new clip, not for one more clip: a sample that covers a whole clip makes Live delete that clip.
      const isNew = (clip: ArrangementClipDescriptor) => Math.abs(clip.startBeats - input.startBeats) <= TIME_TOLERANCE && !before.some(old => same(clip, old));
      const { value: after, settled } = await this.poll(() => this.arrangementClips(input.trackIndex), clips => clips.some(isNew), SAMPLE_POLL_ATTEMPTS);
      if (!settled) throw new Error(`Live did not show a new clip at beat ${input.startBeats} within 6 seconds. Check the track before retrying; the load may still finish.`);
      const untouched = before.every(old => after.some(clip => same(clip, old)));
      const created = after.find(isNew);
      if (!untouched || !created) {
        // Live trims a clip the new one overlaps. The load was one undo step, so undo it to restore that clip.
        await this.live.send("/live/song/undo", []);
        const restored = await this.poll(() => this.arrangementClips(input.trackIndex), clips => clips.length === before.length && before.every(old => clips.some(clip => same(clip, old))));
        const next = before.filter(old => !after.some(clip => same(clip, old))).sort((a, b) => a.startBeats - b.startBeats)[0];
        throw new Error(`The sample would overlap ${next ? `clip '${next.name}' at beat ${next.startBeats}` : "an existing clip"}, so the load was undone${restored.settled ? "" : ", but Live did not confirm the track is back as it was. Check it"}. Pick a later start or clear the range.`);
      }
      return { trackIndex: input.trackIndex, ...(await this.trackNameAfter(input.trackIndex, input.expectedTrackName)), file: path, clip: created };
    });
  }

  replaceSimplerSample(input: { trackIndex: number; expectedTrackName: string; deviceIndex: number; expectedDeviceName: string; sampleId?: number; path?: string; dryRun?: boolean }): Promise<ToolResult> {
    let path = "";
    const target = (trackName = input.expectedTrackName, deviceName = input.expectedDeviceName): OscArgument[] => [oscInt(input.trackIndex), trackName, oscInt(input.deviceIndex), deviceName];
    const current = async (trackName?: string, deviceName?: string) => (await this.live.query("/live/device/get/sample", target(trackName, deviceName))).args[3] as string | null;
    // Live may rename an untitled track, or the device, after the new sample. Read both again by index.
    const currentAfter = async () => {
      const trackName = (await this.trackNames())[input.trackIndex];
      const devices = (await this.live.query("/live/track/get/devices/name", [oscInt(input.trackIndex)])).args.slice(1).map(String);
      return current(trackName, devices[input.deviceIndex]);
    };
    return this.change("replace_simpler_sample", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.deviceIndex, "Device index");
      path = await this.samplePath(input);
      const before = await current();
      if (before === path) throw new Error(`Simpler already plays ${path}.`);
      return { address: "/live/device/replace_sample", args: [...target(), path], before };
    }, async before => {
      const { value: after, settled } = await this.poll(currentAfter, file => file === path, SAMPLE_POLL_ATTEMPTS);
      if (!settled) throw new Error(`Simpler's sample reads ${after ?? "empty"}, not ${path}.`);
      const deviceName = String((await this.live.query("/live/track/get/devices/name", [oscInt(input.trackIndex)])).args[input.deviceIndex + 1]);
      const trackName = (await this.trackNames())[input.trackIndex];
      const renamed = [
        trackName !== input.expectedTrackName ? `the track from '${input.expectedTrackName}' to '${trackName}'` : null,
        deviceName !== input.expectedDeviceName ? `the device from '${input.expectedDeviceName}' to '${deviceName}'` : null
      ].filter(Boolean);
      const note = renamed.length ? `Live renamed ${renamed.join(" and ")}. Use the new names in later calls.` : undefined;
      return { trackIndex: input.trackIndex, trackName, deviceIndex: input.deviceIndex, deviceName, previousFile: before, file: after, ...(note ? { note } : {}) };
    });
  }


  // ------------------------------------------------------------------ device on/off and delete

  private async deviceStates(kind: TrackKind, index: number): Promise<{ trackName: string; devices: Array<{ deviceIndex: number; name: string; className: string; enabled: boolean | null }> }> {
    const args = (await this.live.query("/live/devices/get/state", trackArgs(kind, index))).args;
    const count = Number(args[3]);
    if (!Number.isInteger(count) || args.length !== 4 + count * 3) throw new Error("Device state reply has the wrong length. Reinstall the Control Deck remote script and restart Live.");
    const devices = [];
    for (let position = 0; position < count; position++) {
      const [name, className, enabled] = args.slice(4 + position * 3, 7 + position * 3);
      devices.push({ deviceIndex: position, name: String(name), className: String(className), enabled: typeof enabled === "boolean" ? enabled : null });
    }
    return { trackName: String(args[2]), devices };
  }

  getDevices(input: { trackKind?: TrackKind; trackIndex: number }): Promise<ToolResult> {
    const kind = input.trackKind ?? "track";
    return this.read("get_devices", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      const { trackName, devices } = await this.deviceStates(kind, input.trackIndex);
      return { trackKind: kind, trackIndex: input.trackIndex, trackName, devices };
    });
  }

  private async requireDevice(input: TrackTarget & { deviceIndex: number; expectedDeviceName: string }) {
    const kind = input.trackKind ?? "track";
    nonNegativeInteger(input.trackIndex, "Track index");
    nonNegativeInteger(input.deviceIndex, "Device index");
    requireName(input.expectedDeviceName, "expectedDeviceName");
    const state = await this.deviceStates(kind, input.trackIndex);
    this.requireTrackName(state.trackName, input.expectedTrackName, kind === "track" ? "track" : `${kind} track`);
    const device = state.devices[input.deviceIndex];
    if (!device) throw new Error(`Device index ${input.deviceIndex} does not exist; '${state.trackName}' has ${state.devices.length} device(s).`);
    if (device.name !== input.expectedDeviceName) throw new Error(`Device safeguard failed: expected device ${input.deviceIndex} to be '${input.expectedDeviceName}', found '${device.name}'.`);
    return { kind, state, device };
  }

  private deviceArgs(input: TrackTarget & { deviceIndex: number; expectedDeviceName: string }): OscArgument[] {
    return [...trackArgs(input.trackKind ?? "track", input.trackIndex), input.expectedTrackName, oscInt(input.deviceIndex), input.expectedDeviceName];
  }

  setDeviceEnabled(input: TrackTarget & { deviceIndex: number; expectedDeviceName: string; enabled: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("set_device_enabled", input, input.dryRun ?? false, async () => {
      const { device } = await this.requireDevice(input);
      if (device.enabled === null) throw new Error(`Device '${device.name}' has no on/off switch.`);
      return { address: "/live/device/set_enabled", args: [...this.deviceArgs(input), input.enabled], before: device.enabled };
    }, async before => {
      const kind = input.trackKind ?? "track";
      const { value: after, settled } = await this.poll(() => this.deviceStates(kind, input.trackIndex), state => state.devices[input.deviceIndex]?.enabled === input.enabled);
      if (!settled) throw new Error(`Device '${input.expectedDeviceName}' is ${after.devices[input.deviceIndex]?.enabled ? "on" : "off"}, not ${input.enabled ? "on" : "off"}.`);
      return { trackIndex: input.trackIndex, deviceIndex: input.deviceIndex, name: input.expectedDeviceName, before, enabled: input.enabled };
    });
  }

  deleteDevice(input: TrackTarget & { deviceIndex: number; expectedDeviceName: string; confirm: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("delete_device", input, input.dryRun ?? false, async () => {
      if (input.confirm !== true && !(input.dryRun ?? false)) throw new Error("delete_device requires confirm=true.");
      const { state } = await this.requireDevice(input);
      return { address: "/live/device/delete", args: [...this.deviceArgs(input), input.confirm === true], before: state.devices };
    }, async before => {
      const kind = input.trackKind ?? "track";
      const { value: after, settled } = await this.poll(() => this.deviceStates(kind, input.trackIndex), state => state.devices.length === before.length - 1);
      if (!settled) throw new Error(`The track has ${after.devices.length} devices, expected ${before.length - 1}.`);
      const expected = before.filter((_device, position) => position !== input.deviceIndex).map(device => device.name);
      if (JSON.stringify(after.devices.map(device => device.name)) !== JSON.stringify(expected)) throw new Error(`The device chain is ${after.devices.map(device => device.name).join(", ")}, not ${expected.join(", ")}.`);
      return { deleted: { deviceIndex: input.deviceIndex, name: input.expectedDeviceName }, devices: after.devices };
    });
  }

}
