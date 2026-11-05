import { HYDRA_PARAMETERS, initParameters, parameterById, PITCH_DRIFT_OFF } from "./parameters.js";

export interface PatchRequest {
  description?: string;
  parameters?: Record<string, number>;
  /** False forces the pitch-drift parameters off after the description and the explicit values. */
  pitchDrift?: boolean;
}

export interface ResolvedPatch {
  description: string;
  parameters: Record<string, number>;
  pitchDriftLocked: boolean;
  describedKeys: string[];
}

const PITCH_DRIFT_LOCK = /\bno pitch[ -]?drift\b|\bpitch drift off\b|\bwithout pitch drift\b/i;

export function descriptionDisablesPitchDrift(description: string): boolean {
  return PITCH_DRIFT_LOCK.test(description);
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

/**
 * Keyword baseline for a plain-language description. Explicit `parameters` are
 * applied after this, and the pitch-drift lock is applied last. "Warm" here is
 * a darker filter and a sine blend. It does not enable Hydrasynth Warm Mode,
 * which is analog pitch drift.
 */
export function descriptionOverlay(description: string): Record<string, number> {
  const overlay: Record<string, number> = {};
  const set = (id: string, value: number) => { overlay[id] = value; };
  const minOf = (id: string, value: number) => { overlay[id] = Math.min(overlay[id] ?? value, value); };
  const maxOf = (id: string, value: number) => { overlay[id] = Math.max(overlay[id] ?? value, value); };

  if (hasWord(description, "pad")) {
    set("osc1mode", 0);
    set("osc1type", 3);
    set("osc2mode", 0);
    set("osc2type", 0);
    set("osc2semi", 0);
    set("mixerosc1vol", 880);
    set("mixerosc2vol", 620);
    set("mixerosc3vol", 0);
    set("mixernoisevol", 0);
    set("mixerringmodvol", 0);
    set("mutant1wet", 0);
    set("mutant2wet", 0);
    set("mutant3wet", 0);
    set("mutant4wet", 0);
    set("filter1type", 0);
    set("filter1cutoff", 400);
    set("filter1resonance", 70);
    set("filter1drive", 0);
    set("filter1env1amount", 600);
    set("filter2cutoff", 0);
    set("env1attacksyncoff", 340);
    set("env1decaysyncoff", 260);
    set("env1sustain", 720);
    set("env1releasesyncoff", 480);
    set("env2attacksyncoff", 460);
    set("env2decaysyncoff", 180);
    set("env2sustain", 880);
    set("env2releasesyncoff", 620);
    set("amplevel", 700);
    set("reverbtype", 0);
    set("reverbtime", 540);
    set("reverbwet", 340);
    set("delaywet", 140);
    set("delayfeedback", 200);
    set("delaytimesyncoff", 460);
  }
  if (hasWord(description, "soft")) {
    minOf("filter1cutoff", 360);
    minOf("filter1resonance", 40);
    maxOf("env2attacksyncoff", 520);
  }
  if (hasWord(description, "warm")) {
    set("filter1type", 0);
    set("osc2type", 0);
    minOf("filter1cutoff", 320);
    maxOf("mixerosc2vol", 700);
  }
  if (hasWord(description, "bass")) {
    set("osc1semi", -12);
    set("osc1type", 3);
    minOf("filter1cutoff", 240);
    set("env2attacksyncoff", 0);
    minOf("env2releasesyncoff", 120);
    set("reverbwet", 0);
  }
  if (hasWord(description, "pluck")) {
    set("env2attacksyncoff", 0);
    set("env2sustain", 0);
    set("env2decaysyncoff", 280);
    set("env2releasesyncoff", 180);
    set("filter1env1amount", 760);
    minOf("reverbwet", 80);
  }
  if (hasWord(description, "bright")) {
    maxOf("filter1cutoff", 900);
  }
  for (const id of Object.keys(overlay)) {
    if (!parameterById(id)) throw new Error(`Description overlay used an unknown parameter ${id}.`);
  }
  return overlay;
}

export function resolvePatch(input: PatchRequest): ResolvedPatch {
  const description = input.description?.trim() ?? "";
  const parameters = initParameters();
  const overlay = description ? descriptionOverlay(description) : {};
  for (const [id, value] of Object.entries(overlay)) parameters[id] = value;
  for (const [id, value] of Object.entries(input.parameters ?? {})) {
    const parameter = parameterById(id);
    if (!parameter) throw new Error(`Unknown Hydrasynth parameter "${id}". Call hydra_list_parameters for the Phase 1 ids.`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < parameter.min || value > parameter.max) {
      throw new Error(`${id} must be an integer from ${parameter.min} to ${parameter.max}.`);
    }
    parameters[id] = value;
  }
  const pitchDriftLocked = input.pitchDrift === false || descriptionDisablesPitchDrift(description);
  if (pitchDriftLocked) {
    for (const [id, value] of Object.entries(PITCH_DRIFT_OFF)) parameters[id] = value;
  }
  const known = new Set(HYDRA_PARAMETERS.map(parameter => parameter.id));
  for (const id of Object.keys(parameters)) {
    if (!known.has(id)) throw new Error(`Resolved patch contains unknown parameter ${id}.`);
  }
  return { description, parameters, pitchDriftLocked, describedKeys: Object.keys(overlay) };
}
