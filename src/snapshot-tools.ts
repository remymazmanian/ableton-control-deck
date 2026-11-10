import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromProjectRoot } from "./paths.js";
import { parseMixer, parsePairs, parseScenes, type TrackKind } from "./session-tools.js";
import { TheoryTools } from "./theory-tools.js";
import { oscInt, type ToolResult } from "./types.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export interface TrackSnapshot {
  kind: TrackKind; index: number; name: string;
  mix: { volume: string; pan: string; mute: boolean | null; solo: boolean | null; sends: string[] };
  routing: Record<string, unknown> | null;
  devices: Array<{ name: string; className: string; enabled: boolean | null; parameters: Record<string, string> }>;
}
export interface ClipSnapshot { track: number; scene: number; name: string; kind: string; props: Record<string, unknown>; noteCount: number | null; notesHash: string | null }
export interface SetSnapshot {
  name: string; takenAt: string; tempo: number; signature: string;
  song: Record<string, unknown> | null;
  scenes: Array<{ name: string; color: string | null; tempo: number | null; timeSignature: unknown }>;
  tracks: TrackSnapshot[];
  clips: ClipSnapshot[];
}

/** Plain words for a value: numbers rounded, text as is, nothing as "none", anything else as JSON. */
const fmt = (value: unknown): string =>
  typeof value === "number" ? String(Math.round(value * 1000) / 1000) : typeof value === "string" ? value : value === null || value === undefined ? "none" : JSON.stringify(value);

/** Compare two snapshots and describe every difference in plain words. */
export function diffSnapshots(before: SetSnapshot, after: SetSnapshot): string[] {
  const changes: string[] = [];
  if (before.tempo !== after.tempo) changes.push(`Tempo: ${before.tempo} → ${after.tempo} BPM`);
  if (before.signature !== after.signature) changes.push(`Time signature: ${before.signature} → ${after.signature}`);
  for (const key of new Set([...Object.keys(before.song ?? {}), ...Object.keys(after.song ?? {})])) {
    if (["canCaptureMidi", "reEnableAutomationEnabled", "backToArrangementLit", "scaleIntervals", "rootNote", "grooveAmount"].includes(key)) continue;
    if (JSON.stringify(before.song?.[key]) !== JSON.stringify(after.song?.[key])) changes.push(`Song ${key}: ${fmt(before.song?.[key])} → ${fmt(after.song?.[key])}`);
  }
  if (before.scenes.length !== after.scenes.length) changes.push(`Scenes: ${before.scenes.length} → ${after.scenes.length}`);
  before.scenes.forEach((scene, index) => {
    const now = after.scenes[index];
    if (!now) return;
    for (const key of ["name", "color", "tempo", "timeSignature"] as const) if (JSON.stringify(scene[key]) !== JSON.stringify(now[key])) changes.push(`Scene ${index + 1} ${key}: ${fmt(scene[key])} → ${fmt(now[key])}`);
  });
  const id = (track: TrackSnapshot) => `${track.kind}:${track.name}`;
  const label = (track: TrackSnapshot) => (track.kind === "master" ? "Master" : track.kind === "return" ? `Return '${track.name}'` : `Track '${track.name}'`);
  const beforeTracks = new Map(before.tracks.map(track => [id(track), track]));
  const afterTracks = new Map(after.tracks.map(track => [id(track), track]));
  for (const [key, track] of beforeTracks) if (!afterTracks.has(key)) changes.push(`${label(track)} was removed or renamed`);
  for (const [key, track] of afterTracks) if (!beforeTracks.has(key)) changes.push(`${label(track)} was added (or renamed to this)`);
  for (const [key, now] of afterTracks) {
    const was = beforeTracks.get(key);
    if (!was) continue;
    for (const field of ["volume", "pan", "mute", "solo"] as const) if (JSON.stringify(was.mix[field]) !== JSON.stringify(now.mix[field])) changes.push(`${label(now)}: ${field} ${fmt(was.mix[field])} → ${fmt(now.mix[field])}`);
    now.mix.sends.forEach((send, index) => { if (was.mix.sends[index] !== undefined && was.mix.sends[index] !== send) changes.push(`${label(now)}: send ${String.fromCharCode(65 + index)} ${was.mix.sends[index]} → ${send}`); });
    for (const [field, value] of Object.entries(now.routing ?? {})) if (JSON.stringify(was.routing?.[field]) !== JSON.stringify(value)) changes.push(`${label(now)}: ${field} ${fmt(was.routing?.[field])} → ${fmt(value)}`);
    const wasDevices = was.devices.map(device => device.name).join(" › "), nowDevices = now.devices.map(device => device.name).join(" › ");
    if (wasDevices !== nowDevices) { changes.push(`${label(now)}: devices ${wasDevices || "(none)"} → ${nowDevices || "(none)"}`); continue; }
    now.devices.forEach((device, index) => {
      const old = was.devices[index];
      if (old.enabled !== device.enabled) changes.push(`${label(now)}: '${device.name}' turned ${device.enabled ? "on" : "off"}`);
      for (const [parameter, value] of Object.entries(device.parameters)) {
        if (parameter === "Device On") continue;
        if (old.parameters[parameter] !== undefined && old.parameters[parameter] !== value) changes.push(`${label(now)}: '${device.name}' ${parameter} ${old.parameters[parameter]} → ${value}`);
      }
    });
  }
  const slot = (clip: ClipSnapshot) => `${clip.track}:${clip.scene}`;
  const beforeClips = new Map(before.clips.map(clip => [slot(clip), clip]));
  const afterClips = new Map(after.clips.map(clip => [slot(clip), clip]));
  const where = (clip: ClipSnapshot) => `Clip '${clip.name}' (track ${clip.track + 1}, scene ${clip.scene + 1})`;
  for (const [key, clip] of beforeClips) if (!afterClips.has(key)) changes.push(`${where(clip)} was deleted`);
  for (const [key, clip] of afterClips) {
    const was = beforeClips.get(key);
    if (!was) { changes.push(`${where(clip)} was added`); continue; }
    if (was.name !== clip.name) changes.push(`Clip at track ${clip.track + 1}, scene ${clip.scene + 1}: renamed '${was.name}' → '${clip.name}'`);
    for (const [field, value] of Object.entries(clip.props)) {
      if (["name", "is_playing", "is_triggered"].includes(field)) continue;
      if (JSON.stringify(was.props[field]) !== JSON.stringify(value)) changes.push(`${where(clip)}: ${field} ${fmt(was.props[field])} → ${fmt(value)}`);
    }
    if (was.notesHash !== clip.notesHash) changes.push(`${where(clip)}: notes changed (${was.noteCount === clip.noteCount ? `${clip.noteCount} notes, different pitch, timing, or velocity` : `${was.noteCount} → ${clip.noteCount} notes`})`);
  }
  return changes;
}

export class SnapshotTools extends TheoryTools {
  private folder = fromProjectRoot("data/snapshots");

  private async capture(name: string): Promise<SetSnapshot> {
    const song = await this.live.query("/live/song/get/tempo");
    const numerator = Number((await this.live.query("/live/song/get/signature_numerator")).args.at(-1));
    const denominator = Number((await this.live.query("/live/song/get/signature_denominator")).args.at(-1));
    let settings: Record<string, unknown> | null = null;
    try { settings = JSON.parse(String((await this.live.query("/live/song_settings/get")).args[0])); } catch { settings = null; }
    const scenes = parseScenes((await this.live.query("/live/song/get/scenes")).args).map(scene => ({ name: scene.name, color: scene.color, tempo: scene.tempo, timeSignature: scene.timeSignature }));
    const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
    const tracks: TrackSnapshot[] = [];
    const targets: Array<[TrackKind, number]> = trackNames.map((_name, index) => ["track", index] as [TrackKind, number]);
    for (let index = 0; ; index++) {
      try { await this.live.query("/live/mixer/get", ["return", oscInt(index)]); targets.push(["return", index]); } catch { break; }
    }
    targets.push(["master", 0]);
    for (const [kind, index] of targets) {
      const mixer = parseMixer((await this.live.query("/live/mixer/get", [kind, oscInt(index)])).args);
      let routing: Record<string, unknown> | null = null;
      try {
        const details = parsePairs((await this.live.query("/live/track/get/details", [kind, oscInt(index)])).args, 3);
        routing = Object.fromEntries(Object.entries(details).filter(([key]) => key.includes("routing") || key === "color"));
      } catch { routing = null; }
      const state = (await this.live.query("/live/devices/get/state", [kind, oscInt(index)])).args;
      const devices: TrackSnapshot["devices"] = [];
      for (let k = 0; k < Number(state[3]); k++) {
        const [deviceName, className, enabled] = state.slice(4 + k * 3, 7 + k * 3);
        let parameters: Record<string, string> = {};
        try {
          const parsed = JSON.parse(String((await this.live.query("/live/device_path/get/parameters", [kind, oscInt(index), String(k)])).args[0]));
          parameters = Object.fromEntries(parsed.parameters.map((parameter: { name: string; display: string | null; value: number }) => [parameter.name, parameter.display ?? String(Math.round(parameter.value * 10000) / 10000)]));
        } catch { parameters = {}; }
        devices.push({ name: String(deviceName), className: String(className), enabled: typeof enabled === "boolean" ? enabled : null, parameters });
      }
      tracks.push({ kind, index, name: mixer.name, mix: { volume: mixer.volumeDisplay, pan: mixer.panDisplay, mute: mixer.mute, solo: mixer.solo, sends: mixer.sends.map(send => send.display) }, routing, devices });
    }
    const clips: ClipSnapshot[] = [];
    for (let track = 0; track < trackNames.length; track++) {
      for (let scene = 0; scene < scenes.length; scene++) {
        const slot = (await this.live.query("/live/clip_slot/get/state", [oscInt(track), oscInt(scene)])).args;
        if (slot[2] !== true) continue;
        const props = await this.clipProps(track, scene);
        let noteCount: number | null = null, notesHash: string | null = null;
        if (props.kind === "midi") {
          const notes = (await this.sessionNotes(track, scene)).notes;
          noteCount = notes.length;
          notesHash = createHash("sha256").update(JSON.stringify(notes.map(note => [note.pitch, Math.round(note.startTime * 1000), Math.round(note.duration * 1000), Math.round(note.velocity), note.mute]))).digest("hex").slice(0, 16);
        }
        clips.push({ track, scene, name: String(props.props.name ?? ""), kind: String(props.kind), props: props.props, noteCount, notesHash });
      }
    }
    return { name, takenAt: new Date().toISOString(), tempo: Number(song.args.at(-1)), signature: `${numerator}/${denominator}`, song: settings, scenes, tracks, clips };
  }

  private pathFor(name: string): string {
    if (!NAME.test(name)) throw new Error("A snapshot name is 1-64 letters, numbers, spaces, dots, dashes, or underscores, starting with a letter or number.");
    return join(this.folder, `${name}.json`);
  }

  snapshotSet(input: { name: string; overwrite?: boolean }): Promise<ToolResult> {
    return this.read("snapshot_set", async () => {
      const path = this.pathFor(input.name);
      const exists = await stat(path).then(() => true, () => false);
      if (exists && input.overwrite !== true) throw new Error(`A snapshot named '${input.name}' exists. Pass overwrite: true to replace it.`);
      const snapshot = await this.capture(input.name);
      await mkdir(this.folder, { recursive: true });
      await writeFile(path, JSON.stringify(snapshot, null, 1));
      return { name: input.name, takenAt: snapshot.takenAt, tracks: snapshot.tracks.length, devices: snapshot.tracks.reduce((sum, track) => sum + track.devices.length, 0), clips: snapshot.clips.length, scenes: snapshot.scenes.length };
    });
  }

  listSnapshots(): Promise<ToolResult> {
    return this.read("list_snapshots", async () => {
      const files = await readdir(this.folder).catch(() => [] as string[]);
      const snapshots = [];
      for (const file of files.filter(file => file.endsWith(".json")).sort()) {
        try { const data = JSON.parse(await readFile(join(this.folder, file), "utf8")) as SetSnapshot; snapshots.push({ name: data.name, takenAt: data.takenAt, tracks: data.tracks.length, clips: data.clips.length }); } catch { /* skip unreadable files */ }
      }
      return { snapshots };
    });
  }

  diffSnapshot(input: { name: string; against?: string }): Promise<ToolResult> {
    return this.read("diff_snapshot", async () => {
      const load = async (name: string) => {
        try { return JSON.parse(await readFile(this.pathFor(name), "utf8")) as SetSnapshot; } catch (error) {
          if (error instanceof Error && /name is/.test(error.message)) throw error;
          throw new Error(`No snapshot named '${name}'. List them with list_snapshots.`);
        }
      };
      const before = await load(input.name);
      const after = input.against ? await load(input.against) : await this.capture("now");
      const changes = diffSnapshots(before, after);
      return { from: `${before.name} (${before.takenAt})`, to: input.against ? `${after.name} (${after.takenAt})` : "the set now", changeCount: changes.length, changes: changes.slice(0, 300), truncated: changes.length > 300 };
    });
  }
}
