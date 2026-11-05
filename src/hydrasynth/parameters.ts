/**
 * Key ASM Hydrasynth Desktop parameters for Phase 1.
 *
 * NRPN numbers and the way each value is packed come from Sean Luke's corrected
 * table, not from ASM's published PDF (Edisyn documents that PDF as wrong in
 * many places and lacking display ranges):
 *
 * - Encoder and `nrpn` array: edisyn/synth/asmhydrasynth/ASMHydrasynth.java
 *   https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/ASMHydrasynth.java
 * - Spreadsheet: edisyn/synth/asmhydrasynth/info/nrpn.csv
 *   https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/nrpn.csv
 *
 * Model values match Edisyn's dial ranges. Continuous controls that Edisyn
 * multiplies by 8 are marked `times8`. Signed cents use Edisyn's `value + 8192`
 * form (the CSV prose is off by one at the negative end; the Java encoder is
 * what Edisyn sends). Oscillator semitone and mode share one NRPN per family;
 * the data-entry MSB selects the oscillator.
 *
 * Init numbers were read out of Edisyn's ASMHydrasynth.init preset (patch name
 * "Init", firmware byte 0xC8 / 2.0.0) using the offsets in that same Java file
 * and in info/SysexPatchFormat.txt. They are the baseline every apply starts
 * from. Parameters that are not in this list are left untouched.
 */

export const HYDRA_SOURCES = {
  nrpnCsv: "https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/nrpn.csv",
  encoder: "https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/ASMHydrasynth.java",
  sysexEncoding: "https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/SysexEncoding.txt",
  sysexPatchFormat: "https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/SysexPatchFormat.txt",
  asmPdfNote: "ASM's Hydrasynth MIDI NRPN PDF is the list Edisyn corrects. When the two disagree, these numbers follow Edisyn."
} as const;

export type ParameterOrder = "mode" | "type" | "lfoWave" | "bpmSync" | "rest";
export type ParameterGroup = "oscillator" | "mixer" | "mutant" | "filter" | "amp" | "envelope" | "lfo" | "effect" | "voice";
export type EncodeKind = "direct" | "times8" | "signed14" | "selector" | "packed";

export interface HydraParameter {
  id: string;
  group: ParameterGroup;
  /** Edisyn's recommended send order: modes, types, LFO waves, BPM sync, then the rest. */
  order: ParameterOrder;
  nrpnMsb: number;
  nrpnLsb: number;
  min: number;
  max: number;
  kind: EncodeKind;
  /** Data-entry MSB when several parameters share one NRPN (oscillator mode and semitone). */
  selectorMsb?: number;
  /** Data-entry MSB for parameters packed onto a shared LFO NRPN. */
  packedMsb?: number;
  init: number;
  unit: string;
}

interface Row {
  id: string;
  group: ParameterGroup;
  order: ParameterOrder;
  nrpnMsb: number;
  nrpnLsb: number;
  min: number;
  max: number;
  kind: EncodeKind;
  init: number;
  unit: string;
  selectorMsb?: number;
  packedMsb?: number;
}

const rows: Row[] = [
  { id: "osc1mode", group: "oscillator", order: "mode", nrpnMsb: 0x3f, nrpnLsb: 0x18, min: 0, max: 1, kind: "selector", selectorMsb: 0, init: 0, unit: "0 Single, 1 WaveScan" },
  { id: "osc2mode", group: "oscillator", order: "mode", nrpnMsb: 0x3f, nrpnLsb: 0x18, min: 0, max: 1, kind: "selector", selectorMsb: 1, init: 0, unit: "0 Single, 1 WaveScan" },
  { id: "osc1type", group: "oscillator", order: "type", nrpnMsb: 0x3f, nrpnLsb: 0x19, min: 0, max: 218, kind: "direct", init: 3, unit: "wave index, 0 Sine, 1 Triangle, 3 Saw, 4 Square" },
  { id: "osc2type", group: "oscillator", order: "type", nrpnMsb: 0x3f, nrpnLsb: 0x1a, min: 0, max: 218, kind: "direct", init: 3, unit: "wave index, 0 Sine, 1 Triangle, 3 Saw, 4 Square" },
  { id: "osc3type", group: "oscillator", order: "type", nrpnMsb: 0x3f, nrpnLsb: 0x0d, min: 0, max: 218, kind: "direct", init: 3, unit: "wave index, 0 Sine, 1 Triangle, 3 Saw, 4 Square" },
  { id: "filter1type", group: "filter", order: "type", nrpnMsb: 0x3f, nrpnLsb: 0x28, min: 0, max: 15, kind: "direct", init: 0, unit: "0 LP Ladder 12, 1 LP Ladder 24, 2 LP Fat 12, 3 LP Fat 24" },
  { id: "filter2type", group: "filter", order: "type", nrpnMsb: 0x3f, nrpnLsb: 0x23, min: 0, max: 1, kind: "direct", init: 0, unit: "0 LP-BP-HP, 1 LP-Notch-HP" },
  { id: "delaytype", group: "effect", order: "type", nrpnMsb: 0x3b, nrpnLsb: 0x71, min: 0, max: 4, kind: "times8", init: 0, unit: "0 Basic Mono, 1 Basic Stereo, 2 Pan, 3 LRC, 4 Reverse" },
  { id: "reverbtype", group: "effect", order: "type", nrpnMsb: 0x3c, nrpnLsb: 0x72, min: 0, max: 3, kind: "times8", init: 0, unit: "0 Hall, 1 Room, 2 Plate, 3 Cloud" },
  { id: "lfo1wave", group: "lfo", order: "lfoWave", nrpnMsb: 0x3f, nrpnLsb: 0x04, min: 0, max: 10, kind: "packed", packedMsb: 0x00, init: 0, unit: "0 Sine, 1 Triangle, 2 Saw Up, 3 Saw Down, 4 Square" },

  { id: "osc1semi", group: "oscillator", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x11, min: -36, max: 36, kind: "selector", selectorMsb: 0, init: 0, unit: "semitones" },
  { id: "osc2semi", group: "oscillator", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x11, min: -36, max: 36, kind: "selector", selectorMsb: 1, init: 0, unit: "semitones" },
  { id: "osc3semi", group: "oscillator", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x11, min: -36, max: 36, kind: "selector", selectorMsb: 2, init: -12, unit: "semitones" },
  { id: "osc1cent", group: "oscillator", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x01, min: -50, max: 50, kind: "signed14", init: 0, unit: "cents" },
  { id: "osc2cent", group: "oscillator", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x02, min: -50, max: 50, kind: "signed14", init: 0, unit: "cents" },
  { id: "osc3cent", group: "oscillator", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x03, min: -50, max: 50, kind: "signed14", init: 0, unit: "cents" },
  { id: "osc1wavscan", group: "oscillator", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x2a, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel about 1.0-8.0" },
  { id: "osc2wavscan", group: "oscillator", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x2b, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel about 1.0-8.0" },
  { id: "osc1keytrack", group: "oscillator", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x54, min: 0, max: 200, kind: "direct", init: 100, unit: "percent" },

  { id: "mixerosc1vol", group: "mixer", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x07, min: 0, max: 1024, kind: "times8", init: 1024, unit: "0-1024, panel 0.0-128.0" },
  { id: "mixerosc2vol", group: "mixer", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x08, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "mixerosc3vol", group: "mixer", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x09, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "mixernoisevol", group: "mixer", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x0d, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "mixerringmodvol", group: "mixer", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x01, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "mixerfilterrouting", group: "mixer", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x2c, min: 0, max: 1, kind: "direct", init: 0, unit: "0 Series, 1 Parallel" },

  { id: "mutant1wet", group: "mutant", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x22, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024 wet. Init is dry so a mutant preset is silenced" },
  { id: "mutant2wet", group: "mutant", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x23, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024 wet" },
  { id: "mutant3wet", group: "mutant", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x24, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024 wet" },
  { id: "mutant4wet", group: "mutant", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x17, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024 wet" },

  { id: "filter1cutoff", group: "filter", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x28, min: 0, max: 1024, kind: "times8", init: 1024, unit: "0-1024, panel 0.0-128.0" },
  { id: "filter1resonance", group: "filter", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x29, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "filter1drive", group: "filter", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x2b, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "filter1env1amount", group: "filter", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x61, min: 0, max: 1024, kind: "times8", init: 512, unit: "bipolar, 512 is zero" },
  { id: "filter1lfo1amount", group: "filter", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x60, min: 0, max: 1024, kind: "times8", init: 512, unit: "bipolar filter wobble, 512 is zero. Not pitch" },
  { id: "filter2cutoff", group: "filter", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x2c, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "filter2resonance", group: "filter", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x2d, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel 0.0-128.0" },
  { id: "filter2env1amount", group: "filter", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x63, min: 0, max: 1024, kind: "times8", init: 512, unit: "bipolar, 512 is zero" },

  { id: "amplevel", group: "amp", order: "rest", nrpnMsb: 0x40, nrpnLsb: 0x02, min: 0, max: 1024, kind: "times8", init: 512, unit: "0-1024, panel 0.0-128.0" },
  { id: "env1attacksyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x11, min: 0, max: 1024, kind: "times8", init: 0, unit: "filter envelope attack, free-running, 0-1024" },
  { id: "env1decaysyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x1b, min: 0, max: 1024, kind: "times8", init: 0, unit: "filter envelope decay, free-running, 0-1024" },
  { id: "env1sustain", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x20, min: 0, max: 1024, kind: "times8", init: 1024, unit: "filter envelope sustain, 0-1024" },
  { id: "env1releasesyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x25, min: 0, max: 1024, kind: "times8", init: 0, unit: "filter envelope release, free-running, 0-1024" },
  { id: "env2attacksyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x12, min: 0, max: 1024, kind: "times8", init: 0, unit: "amp envelope attack, free-running, 0-1024" },
  { id: "env2decaysyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x1c, min: 0, max: 1024, kind: "times8", init: 0, unit: "amp envelope decay, free-running, 0-1024" },
  { id: "env2sustain", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x21, min: 0, max: 1024, kind: "times8", init: 1024, unit: "amp envelope sustain, 0-1024" },
  { id: "env2releasesyncoff", group: "envelope", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x26, min: 0, max: 1024, kind: "times8", init: 0, unit: "amp envelope release, free-running, 0-1024" },

  { id: "lfo1ratesyncoff", group: "lfo", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x05, min: 0, max: 1024, kind: "times8", init: 449, unit: "free-running rate, 0-1024" },
  { id: "lfo1level", group: "lfo", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x0b, min: 0, max: 1024, kind: "times8", init: 1024, unit: "LFO 1 output level, 0-1024. Depth into the filter is filter1lfo1amount" },
  { id: "amplfo2amount", group: "amp", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x64, min: 0, max: 1024, kind: "times8", init: 512, unit: "bipolar tremolo, 512 is zero. Not pitch" },

  { id: "delaytimesyncoff", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x74, min: 0, max: 1024, kind: "times8", init: 424, unit: "free-running delay time, 0-1024" },
  { id: "delayfeedback", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x75, min: 0, max: 1024, kind: "times8", init: 256, unit: "0-1024" },
  { id: "delaywet", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x78, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024 dry/wet" },
  { id: "reverbtime", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x79, min: 0, max: 1024, kind: "times8", init: 161, unit: "0-1024" },
  { id: "reverbtone", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x7a, min: 0, max: 1024, kind: "times8", init: 512, unit: "bipolar, 512 is center" },
  { id: "reverbwet", group: "effect", order: "rest", nrpnMsb: 0x41, nrpnLsb: 0x7e, min: 0, max: 1024, kind: "times8", init: 0, unit: "0-1024, panel about 0-100%" },

  { id: "voicedetune", group: "voice", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x39, min: 0, max: 127, kind: "direct", init: 32, unit: "voice detune. Init is 32. Forced to 0 by no pitch drift" },
  { id: "voiceanalogfeel", group: "voice", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x46, min: 0, max: 127, kind: "direct", init: 0, unit: "analog feel. Forced to 0 by no pitch drift" },
  { id: "voicevibratoamount", group: "voice", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x43, min: 0, max: 120, kind: "direct", init: 2, unit: "0-120, panel amount/10. Init is 0.2. Forced to 0 by no pitch drift" },
  { id: "voicewarmmode", group: "voice", order: "rest", nrpnMsb: 0x3f, nrpnLsb: 0x4f, min: 0, max: 1, kind: "direct", init: 0, unit: "0 off, 1 on. This is analog pitch drift, not tonal warmth" }
];

export const HYDRA_PARAMETERS: HydraParameter[] = rows;

const byId = new Map(HYDRA_PARAMETERS.map(parameter => [parameter.id, parameter]));

export function parameterById(id: string): HydraParameter | undefined {
  return byId.get(id);
}

export function encodeModelValue(parameter: HydraParameter, modelValue: number): number {
  if (!Number.isInteger(modelValue) || modelValue < parameter.min || modelValue > parameter.max) {
    throw new Error(`${parameter.id} must be an integer from ${parameter.min} to ${parameter.max}.`);
  }
  switch (parameter.kind) {
    case "direct":
      return modelValue;
    case "times8":
      return modelValue * 8;
    case "signed14":
      return modelValue < 0 ? modelValue + 8192 : modelValue;
    case "selector": {
      const lsb = modelValue < 0 ? modelValue + 128 : modelValue;
      return (parameter.selectorMsb ?? 0) * 128 + lsb;
    }
    case "packed":
      return (parameter.packedMsb ?? 0) * 128 + modelValue;
    default: {
      const unknown: never = parameter.kind;
      throw new Error(`Unknown encode kind ${unknown}.`);
    }
  }
}

/**
 * Free-running attack, LFO rate, and delay time are separate NRPNs from the
 * BPM-sync versions. Edisyn skips the free-running NRPN when sync is on, so a
 * preset with sync enabled would ignore those values. Every apply sets sync off
 * first. The data MSB is Edisyn's pack for that shared NRPN (env 0x0C, LFO 0x01).
 * Delay sync is its own NRPN and uses the times8 rule, so off is 0.
 */
export const BPM_SYNC_OFF = [
  { id: "env1bpmsync", nrpnMsb: 0x3f, nrpnLsb: 0x00, nrpnValue: 0x0c * 128, unit: "envelope 1 BPM sync off, packed MSB 0x0C" },
  { id: "env2bpmsync", nrpnMsb: 0x3f, nrpnLsb: 0x01, nrpnValue: 0x0c * 128, unit: "envelope 2 BPM sync off, packed MSB 0x0C" },
  { id: "lfo1bpmsync", nrpnMsb: 0x3f, nrpnLsb: 0x04, nrpnValue: 0x01 * 128, unit: "LFO 1 BPM sync off, packed MSB 0x01 on the LFO 1 wave NRPN" },
  { id: "delaybpmsync", nrpnMsb: 0x3b, nrpnLsb: 0x70, nrpnValue: 0, unit: "delay BPM sync off" }
] as const;

/** Pitch movement that "no pitch drift" forces off. Semitones are musical transposition and stay. */
export const PITCH_DRIFT_OFF: Record<string, number> = {
  voicedetune: 0,
  voiceanalogfeel: 0,
  voicevibratoamount: 0,
  voicewarmmode: 0,
  osc1cent: 0,
  osc2cent: 0,
  osc3cent: 0
};

export function initParameters(): Record<string, number> {
  return Object.fromEntries(HYDRA_PARAMETERS.map(parameter => [parameter.id, parameter.init]));
}
