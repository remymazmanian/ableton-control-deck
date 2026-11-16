import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { analyzeAudioFile } from "./audio-analysis.js";
import { MidiFileTools } from "./midi-tools.js";
import { fromDataRoot } from "./paths.js";
import type { TrackTarget } from "./session-tools.js";
import { oscFloat, oscInt, type OscArgument, type ToolResult } from "./types.js";

export const CAPTURE_TAPS = ["post_mixer", "post_fx", "pre_fx"] as const;
export type CaptureTap = typeof CAPTURE_TAPS[number];
const KEEP_CAPTURES = 40;
/** Wavetable's modulation sources, in matrix column order. */
export const WAVETABLE_SOURCES = ["Env 1 (Amp)", "Env 2", "Env 3", "LFO 1", "LFO 2", "Velocity", "Note", "Pitch Bend", "Pressure", "Mod Wheel", "Random", "Note PB", "Slide"];

interface DeviceTarget extends TrackTarget { deviceIndex: number; expectedDeviceName: string }
interface PropertyState { device: string; className: string; properties: Record<string, { value: number | boolean | null; options?: string[]; label?: string }>; lists: Record<string, string[]> }
interface ModulationState { device: string; sourceCount: number; targets: Array<{ target: string; amounts: Array<number | null> }>; addableTargets: string[] }
interface CaptureState { exists: boolean; tempo: number; playing: boolean; trackIndex?: number; triggered?: boolean; recording?: boolean; hasClip?: boolean; filePath?: string | null; lengthBeats?: number | null }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function deviceArgs(input: DeviceTarget): OscArgument[] {
  return [input.trackKind ?? "track", oscInt(input.trackIndex), input.expectedTrackName, oscInt(input.deviceIndex), input.expectedDeviceName];
}

function sourceLabels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => WAVETABLE_SOURCES[index] ?? `Source ${index}`);
}

export class SoundTools extends MidiFileTools {
  private async properties(input: DeviceTarget): Promise<PropertyState> {
    return JSON.parse(String((await this.live.query("/live/device/get/properties", deviceArgs(input))).args[0]));
  }

  private async modulation(input: DeviceTarget): Promise<ModulationState> {
    return JSON.parse(String((await this.live.query("/live/device/get/modulation", deviceArgs(input))).args[0]));
  }

  private async captureState(): Promise<CaptureState> {
    return JSON.parse(String((await this.live.query("/live/capture/state")).args[0]));
  }

  getDeviceProperties(input: DeviceTarget): Promise<ToolResult> {
    return this.read("get_device_properties", async () => {
      const state = await this.properties(input);
      const wavetables = (oscillator: 1 | 2) => {
        const category = state.properties[`oscillator_${oscillator}_wavetable_category`]?.value;
        const index = state.properties[`oscillator_${oscillator}_wavetable_index`]?.value;
        const categories = state.lists.oscillator_wavetable_categories;
        const tables = state.lists[`oscillator_${oscillator}_wavetables`];
        if (typeof category !== "number" || !categories) return undefined;
        return { category: categories[category] ?? null, table: typeof index === "number" && tables ? tables[index] ?? null : null };
      };
      const summary = state.className === "InstrumentVector" ? { oscillator1: wavetables(1), oscillator2: wavetables(2) } : undefined;
      return { ...state, ...(summary ? { wavetables: summary } : {}) };
    });
  }

  setDeviceProperty(input: DeviceTarget & { property: string; value: number | boolean | string; dryRun?: boolean }): Promise<ToolResult> {
    let wanted: number | boolean = 0;
    return this.change("set_device_property", input, input.dryRun ?? false, async () => {
      const before = await this.properties(input);
      const current = before.properties[input.property];
      if (!current) throw new Error(`'${before.device}' has no setting '${input.property}'. Settings: ${Object.keys(before.properties).join(", ")}.`);
      wanted = this.resolvePropertyValue(before, input.property, input.value);
      const arg: OscArgument = typeof wanted === "boolean" ? wanted : Number.isInteger(wanted) && typeof current.value === "number" && Number.isInteger(current.value) && !input.property.startsWith("sample.") ? oscInt(wanted) : oscFloat(wanted);
      return { address: "/live/device/set_property", args: [...deviceArgs(input), input.property, arg], before: current };
    }, async before => {
      const close = (value: unknown) => (typeof wanted === "number" && typeof value === "number" ? Math.abs(value - wanted) < 1e-4 : value === wanted);
      const { value: after, settled } = await this.poll(() => this.properties(input), state => close(state.properties[input.property]?.value));
      const now = after.properties[input.property];
      if (!settled) throw new Error(`${input.property} reads ${JSON.stringify(now?.value)}, not ${JSON.stringify(wanted)}.`);
      return { device: after.device, property: input.property, before, after: now };
    });
  }

  /** Accepts a number, true/false, an option label ("Shimmer"), or for wavetables a category or table name. */
  private resolvePropertyValue(state: PropertyState, property: string, value: number | boolean | string): number | boolean {
    if (typeof value !== "string") return value;
    const text = value.trim().toLowerCase();
    const options = state.properties[property]?.options
      ?? (property.endsWith("_wavetable_category") ? state.lists.oscillator_wavetable_categories : undefined)
      ?? (property.endsWith("_wavetable_index") ? state.lists[`oscillator_${property.split("_")[1]}_wavetables`] : undefined);
    if (!options) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
      if (text === "true" || text === "false") return text === "true";
      throw new Error(`${property} takes a number.`);
    }
    const index = options.findIndex(option => option.toLowerCase() === text);
    if (index >= 0) return index;
    const close = options.filter(option => option.toLowerCase().includes(text)).slice(0, 12);
    throw new Error(`'${value}' is not an option for ${property}.${close.length ? ` Close: ${close.join(", ")}.` : ` Options: ${options.slice(0, 40).join(", ")}${options.length > 40 ? " …" : ""}.`}`);
  }

  setWavetable(input: DeviceTarget & { oscillator: 1 | 2; category: string; table: string; dryRun?: boolean }): Promise<ToolResult> {
    return this.read("set_wavetable", async () => {
      const prefix = `oscillator_${input.oscillator}_wavetable`;
      const before = await this.properties(input);
      const category = await this.setDeviceProperty({ ...input, property: `${prefix}_category`, value: input.category });
      if (!category.ok) throw new Error(category.error?.message ?? "Could not set the category.");
      if (input.dryRun) return { dryRun: true, category: category.intendedOperations };
      const table = await this.setDeviceProperty({ ...input, property: `${prefix}_index`, value: input.table });
      if (!table.ok) {
        // Put the oscillator back as it was, so a wrong table name changes nothing.
        for (const field of ["category", "index"]) {
          const value = before.properties[`${prefix}_${field}`]?.value;
          if (typeof value === "number") await this.setDeviceProperty({ ...input, property: `${prefix}_${field}`, value });
        }
        throw new Error(table.error?.message ?? "Could not set the wavetable.");
      }
      const state = await this.properties(input);
      const tables = state.lists[`oscillator_${input.oscillator}_wavetables`] ?? [];
      return { oscillator: input.oscillator, category: input.category, table: tables[Number(state.properties[`${prefix}_index`]?.value)] ?? null };
    });
  }

  getModulationMatrix(input: DeviceTarget & { includeEmpty?: boolean }): Promise<ToolResult> {
    return this.read("get_modulation_matrix", async () => {
      const state = await this.modulation(input);
      const sources = sourceLabels(state.sourceCount);
      const routes = state.targets.flatMap(row => row.amounts.flatMap((amount, source) => (amount ? [{ target: row.target, source: sources[source], sourceIndex: source, amount }] : [])));
      return {
        device: state.device,
        sources: sources.map((name, index) => ({ index, name })),
        routes,
        targets: input.includeEmpty ? state.targets : state.targets.map(row => row.target),
        addableTargets: state.addableTargets
      };
    });
  }

  setModulation(input: DeviceTarget & { target: string; source: string | number; amount: number; dryRun?: boolean }): Promise<ToolResult> {
    let sourceIndex = -1;
    return this.change("set_modulation", input, input.dryRun ?? false, async () => {
      const before = await this.modulation(input);
      const labels = sourceLabels(before.sourceCount);
      sourceIndex = typeof input.source === "number" ? input.source : labels.findIndex(label => label.toLowerCase() === String(input.source).trim().toLowerCase() || label.toLowerCase().startsWith(String(input.source).trim().toLowerCase() + " "));
      if (sourceIndex < 0 || sourceIndex >= before.sourceCount) throw new Error(`Source must be 0-${before.sourceCount - 1} or one of: ${labels.join(", ")}.`);
      if (!(input.amount >= -1 && input.amount <= 1)) throw new Error("amount must be from -1 to 1 (Live shows -100% to 100%).");
      const row = before.targets.find(target => target.target === input.target);
      if (!row && !before.addableTargets.includes(input.target)) throw new Error(`'${input.target}' is not a modulation target. Targets: ${before.targets.map(t => t.target).join(", ")}. Addable: ${before.addableTargets.join(", ")}.`);
      return { address: "/live/device/set_modulation", args: [...deviceArgs(input), input.target, oscInt(sourceIndex), oscFloat(input.amount)], before: row?.amounts[sourceIndex] ?? 0 };
    }, async before => {
      const read = (state: ModulationState) => state.targets.find(target => target.target === input.target)?.amounts[sourceIndex];
      const { value: after, settled } = await this.poll(() => this.modulation(input), state => Math.abs((read(state) ?? NaN) - input.amount) < 0.01);
      if (!settled) throw new Error(`${input.target} ← ${sourceLabels(after.sourceCount)[sourceIndex]} reads ${read(after)}, not ${input.amount}.`);
      return { target: input.target, source: sourceLabels(after.sourceCount)[sourceIndex], sourceIndex, before, amount: read(after) };
    });
  }

  /** Records a track's output for a set length into a temporary audio track, keeps the file, and measures it. */
  async captureTrackAudio(input: TrackTarget & { bars?: number; beats?: number; tap?: CaptureTap; scene?: number; expectedClipName?: string; dryRun?: boolean }): Promise<ToolResult> {
    const tool = "capture_track_audio";
    const beats = input.beats ?? (input.bars ?? 2) * 4;
    const tap = input.tap ?? "post_mixer";
    const args: OscArgument[] = [input.trackKind ?? "track", oscInt(input.trackIndex), input.expectedTrackName, oscFloat(beats), tap, oscInt(input.scene ?? -1), input.expectedClipName ?? ""];
    if (input.scene !== undefined && input.expectedClipName === undefined) return { ok: false, dryRun: false, tool, error: { code: "INVALID_ARGUMENTS", message: "Pass expectedClipName with scene (\"\" for an unnamed clip)." } };
    if (input.dryRun) return { ok: true, dryRun: true, tool, intendedOperations: [{ address: "/live/capture/start", args }, { address: "/live/capture/record", args: [] }, { address: "/live/capture/finish", args: [true] }] };
    let started = false;
    try {
      await this.live.send("/live/capture/start", args);
      started = true;
      await sleep(150);
      await this.live.send("/live/capture/record", []);
      let state = await this.captureState();
      const seconds = (beats * 60) / state.tempo;
      // Waits for the launch (up to the launch quantization), then for the recording to finish.
      const deadline = Date.now() + (seconds + 20) * 1000;
      while (Date.now() < deadline && !(state.hasClip && !state.recording && !state.triggered)) {
        await sleep(200);
        state = await this.captureState();
      }
      if (!state.hasClip || state.recording) throw new Error("The capture did not finish recording in time.");
      if (!state.filePath) throw new Error("Live did not report a file for the recording.");
      await this.live.send("/live/capture/finish", [true]);
      started = false;
      const saved = await this.keepCapture(state.filePath, input.expectedTrackName);
      const analysis = await analyzeAudioFile(saved);
      return { ok: true, dryRun: false, tool, data: { track: input.expectedTrackName, beats, tap, file: saved, liveRecording: state.filePath, analysis, ...(analysis.silent ? { warning: "The capture is silent. Is the source playing (pass scene to launch its clip)?" } : {}) } };
    } catch (error) {
      if (started) await this.live.send("/live/capture/finish", [true]).catch(() => undefined);
      return { ok: false, dryRun: false, tool, error: { code: "CAPTURE_FAILED", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async keepCapture(path: string, trackName: string): Promise<string> {
    // Live finishes writing the file just after the clip appears; wait until its size settles.
    let size = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const now = (await stat(path).catch(() => null))?.size ?? -1;
      if (now > 44 && now === size) break;
      size = now;
      await sleep(150);
    }
    const folder = fromDataRoot("data/captures");
    await mkdir(folder, { recursive: true });
    const safe = trackName.replace(/[^\w.-]+/g, "_").slice(0, 40) || "track";
    const target = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}${extname(path) || ".wav"}`);
    await copyFile(path, target);
    const files = (await readdir(folder)).filter(name => !name.startsWith(".")).sort();
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_CAPTURES))) await rm(join(folder, old), { force: true });
    return target;
  }

  analyzeAudio(input: { path: string }): Promise<ToolResult> {
    return this.read("analyze_audio_file", async () => ({ file: basename(input.path), path: input.path, analysis: await analyzeAudioFile(input.path) }));
  }
}
