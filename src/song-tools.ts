import { NoteTools } from "./note-tools.js";
import type { OscArgument, ToolResult } from "./types.js";
import { oscFloat, oscInt } from "./types.js";

export const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const FLATS: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };
/** Live's RecordQuantization values for midi_recording_quantization. */
export const RECORD_QUANTIZATIONS = ["none", "1/4", "1/8", "1/8T", "1/8+1/8T", "1/16", "1/16T", "1/16+1/16T", "1/32"] as const;

export function keyToRoot(key: string | number): number {
  if (typeof key === "number") {
    if (!Number.isInteger(key) || key < 0 || key > 11) throw new Error("key as a number must be 0 (C) to 11 (B).");
    return key;
  }
  const name = FLATS[key.trim()] ?? key.trim().toUpperCase().replace("♯", "#");
  const index = KEYS.indexOf(name as typeof KEYS[number]);
  if (index < 0) throw new Error(`Key '${key}' must be a note name such as C, F#, or Bb.`);
  return index;
}

interface SongSettings {
  rootNote: number | null; key: string | null; scaleName: string | null; scaleMode: boolean | null; scaleIntervals: number[] | null;
  grooveAmount: number | null; loop: { enabled: boolean; startBeats: number; lengthBeats: number };
  punchIn: boolean; punchOut: boolean; arrangementOverdub: boolean; sessionAutomationRecord: boolean; recordQuantization: number | null;
  canCaptureMidi: boolean; reEnableAutomationEnabled: boolean; backToArrangementLit: boolean;
}

export interface SongSettingsInput {
  key?: string | number; scale?: string; scaleMode?: boolean; groovePercent?: number;
  loop?: { enabled?: boolean; startBeats?: number; lengthBeats?: number };
  punchIn?: boolean; punchOut?: boolean; arrangementOverdub?: boolean; sessionAutomationRecord?: boolean;
  recordQuantization?: typeof RECORD_QUANTIZATIONS[number]; dryRun?: boolean;
}

function describe(state: SongSettings) {
  return {
    ...state,
    groovePercent: state.grooveAmount === null ? null : Math.round(state.grooveAmount * 1000) / 10,
    recordQuantization: state.recordQuantization === null ? null : RECORD_QUANTIZATIONS[state.recordQuantization] ?? state.recordQuantization
  };
}

export class SongTools extends NoteTools {
  private async songSettings(): Promise<SongSettings> {
    return JSON.parse(String((await this.live.query("/live/song_settings/get")).args[0]));
  }

  getSongSettings(): Promise<ToolResult> {
    return this.read("get_song_settings", async () => describe(await this.songSettings()));
  }

  setSongSettings(input: SongSettingsInput): Promise<ToolResult> {
    const fields: Array<[string, OscArgument, (state: SongSettings) => boolean]> = [];
    return this.change("set_song_settings", input, input.dryRun ?? false, async () => {
      const add = (field: string, value: OscArgument, check: (state: SongSettings) => boolean) => fields.push([field, value, check]);
      if (input.key !== undefined) { const root = keyToRoot(input.key); add("root_note", oscInt(root), s => s.rootNote === root); }
      if (input.scale !== undefined) { const scale = input.scale.trim(); add("scale_name", scale, s => (s.scaleName ?? "").toLowerCase() === scale.toLowerCase()); }
      if (input.scaleMode !== undefined) add("scale_mode", input.scaleMode, s => s.scaleMode === input.scaleMode);
      if (input.groovePercent !== undefined) {
        if (!(input.groovePercent >= 0 && input.groovePercent <= 131.25)) throw new Error("groovePercent must be from 0 to 131.");
        const amount = input.groovePercent / 100;
        add("groove_amount", oscFloat(amount), s => Math.abs((s.grooveAmount ?? -1) - amount) < 0.005);
      }
      if (input.loop?.startBeats !== undefined) add("loop_start", oscFloat(input.loop.startBeats), s => Math.abs(s.loop.startBeats - input.loop!.startBeats!) < 1e-3);
      if (input.loop?.lengthBeats !== undefined) add("loop_length", oscFloat(input.loop.lengthBeats), s => Math.abs(s.loop.lengthBeats - input.loop!.lengthBeats!) < 1e-3);
      if (input.loop?.enabled !== undefined) add("loop", input.loop.enabled, s => s.loop.enabled === input.loop!.enabled);
      for (const [name, field] of [["punchIn", "punch_in"], ["punchOut", "punch_out"], ["arrangementOverdub", "arrangement_overdub"], ["sessionAutomationRecord", "session_automation_record"]] as const) {
        const value = input[name];
        if (value !== undefined) add(field, value, s => s[name] === value);
      }
      if (input.recordQuantization !== undefined) {
        const index = RECORD_QUANTIZATIONS.indexOf(input.recordQuantization);
        if (index < 0) throw new Error(`recordQuantization must be one of: ${RECORD_QUANTIZATIONS.join(", ")}.`);
        add("midi_recording_quantization", oscInt(index), s => s.recordQuantization === index);
      }
      if (!fields.length) throw new Error("Pass at least one setting.");
      return { address: "/live/song_settings/set", args: fields.flatMap(([field, value]) => [field, value]), before: await this.songSettings() };
    }, async before => {
      const { value: after, settled } = await this.poll(() => this.songSettings(), state => fields.every(([, , check]) => check(state)));
      if (!settled) {
        const wrong = fields.filter(([, , check]) => !check(after)).map(([field]) => field);
        throw new Error(`Live did not take ${wrong.join(", ")}.${wrong.includes("scale_name") ? " Check the scale name matches one in Live's Scale menu." : ""}`);
      }
      return { before: describe(before), after: describe(after) };
    });
  }

  songAction(input: { action: "capture_midi" | "re_enable_automation" | "back_to_arrangement"; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("song_action", input, input.dryRun ?? false, async () => {
      if (!["capture_midi", "re_enable_automation", "back_to_arrangement"].includes(input.action)) throw new Error("action must be capture_midi, re_enable_automation, or back_to_arrangement.");
      return { address: "/live/song_settings/action", args: [input.action], before: await this.songSettings() };
    }, async before => {
      const after = await this.songSettings();
      return { action: input.action, before: describe(before), after: describe(after) };
    });
  }
}
