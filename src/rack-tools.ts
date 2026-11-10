import { nonNegativeInteger, requireName, SessionTools, trackArgs, type TrackKind } from "./session-tools.js";
import { oscFloat, oscInt, type OscArgument, type ToolResult } from "./types.js";
import { noteNameToMidi } from "./validation.js";

/** A device inside a rack is addressed by a path: "0" is the first device, "0/2/1" is device 1 in chain 2 of that rack. */
export const DEVICE_PATH = /^\d+(\/\d+\/\d+){0,7}$/;
const VALUE_TOLERANCE = 1e-4;

export interface ParameterState { index: number; name: string; value: number; min: number; max: number; display: string | null; quantized: boolean }
export interface RackState {
  path: string; name: string; className: string; isDrumRack: boolean;
  visibleMacroCount: number; macros: ParameterState[];
  chains: Array<{ index: number; name: string; mute: boolean; solo: boolean; devices: Array<{ path: string; name: string; className: string; enabled: boolean | null; isRack: boolean }> }>;
  variations: { count: number; selected: number } | null;
  drumPads?: Array<{ note: number; name: string; mute: boolean; solo: boolean; chainCount: number }>;
}

interface RackTarget { trackKind?: TrackKind; trackIndex: number; expectedTrackName: string; path: string }

function checkPath(path: string): void {
  if (!DEVICE_PATH.test(path)) throw new Error(`Device path '${path}' must be a device index, or device/chain/device such as 0/2/1.`);
}

export class RackTools extends SessionTools {
  private async rackState(kind: TrackKind, trackIndex: number, path: string): Promise<RackState> {
    return JSON.parse(String((await this.live.query("/live/rack/get", [...trackArgs(kind, trackIndex), path])).args[0])) as RackState;
  }

  private async pathParameters(kind: TrackKind, trackIndex: number, path: string): Promise<{ path: string; name: string; className: string; parameters: ParameterState[] }> {
    return JSON.parse(String((await this.live.query("/live/device_path/get/parameters", [...trackArgs(kind, trackIndex), path])).args[0]));
  }

  private target(input: RackTarget): OscArgument[] {
    return [...trackArgs(input.trackKind ?? "track", input.trackIndex), input.expectedTrackName, input.path];
  }

  /** Check the track and the rack at the path by their current names, and return the rack. */
  private async requireRack(input: RackTarget & { expectedRackName: string }): Promise<RackState> {
    nonNegativeInteger(input.trackIndex, "Track index");
    checkPath(input.path);
    requireName(input.expectedRackName, "expectedRackName");
    const names = await this.trackNameOf(input.trackKind ?? "track", input.trackIndex);
    this.requireTrackName(names, input.expectedTrackName);
    const rack = await this.rackState(input.trackKind ?? "track", input.trackIndex, input.path);
    if (rack.name !== input.expectedRackName) throw new Error(`Rack safeguard failed: expected the device at ${input.path} to be '${input.expectedRackName}', found '${rack.name}'.`);
    return rack;
  }

  private async trackNameOf(kind: TrackKind, trackIndex: number): Promise<string> {
    return String((await this.live.query("/live/devices/get/state", trackArgs(kind, trackIndex))).args[2]);
  }

  getRack(input: { trackKind?: TrackKind; trackIndex: number; path: string }): Promise<ToolResult> {
    return this.read("get_rack", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      checkPath(input.path);
      return this.rackState(input.trackKind ?? "track", input.trackIndex, input.path);
    });
  }

  getDeviceParametersAtPath(input: { trackKind?: TrackKind; trackIndex: number; path: string }): Promise<ToolResult> {
    return this.read("get_device_parameters_at_path", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      checkPath(input.path);
      return this.pathParameters(input.trackKind ?? "track", input.trackIndex, input.path);
    });
  }

  setRackMacros(input: RackTarget & { expectedRackName: string; macros: Array<{ macro: number; value: number }>; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("set_rack_macros", input, input.dryRun ?? false, async () => {
      if (!input.macros?.length) throw new Error("Pass at least one macro.");
      const rack = await this.requireRack(input);
      const seen = new Set<number>();
      for (const { macro, value } of input.macros) {
        if (!Number.isInteger(macro) || macro < 1 || macro > 16) throw new Error("Macro numbers run from 1 to 16.");
        if (seen.has(macro)) throw new Error(`Macro ${macro} was given twice.`);
        seen.add(macro);
        const state = rack.macros.find(entry => entry.index === macro);
        if (!state) throw new Error(`Rack '${rack.name}' shows ${rack.visibleMacroCount} macros; macro ${macro} is not visible.`);
        if (!Number.isFinite(value) || value < state.min || value > state.max) throw new Error(`Macro ${macro} (${state.name}) must be from ${state.min} to ${state.max}.`);
      }
      return { address: "/live/rack/set_macros", args: [...this.target(input), input.expectedRackName, ...input.macros.flatMap(({ macro, value }) => [oscInt(macro), oscFloat(value)])], before: rack.macros };
    }, async before => {
      const done = (rack: RackState) => input.macros.every(({ macro, value }) => Math.abs((rack.macros.find(entry => entry.index === macro)?.value ?? NaN) - value) <= VALUE_TOLERANCE);
      const { value: after, settled } = await this.poll(() => this.rackState(input.trackKind ?? "track", input.trackIndex, input.path), done);
      if (!settled) throw new Error("Live did not show every macro at the value asked for.");
      const changed = input.macros.map(({ macro }) => after.macros.find(entry => entry.index === macro)!);
      return { rack: after.name, macros: changed, before: before.filter(entry => input.macros.some(({ macro }) => macro === entry.index)) };
    });
  }

  setRackChain(input: RackTarget & { expectedRackName: string; chainIndex: number; expectedChainName: string; name?: string; mute?: boolean; solo?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("set_rack_chain", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.chainIndex, "Chain index");
      const fields: OscArgument[] = [];
      if (input.name !== undefined) fields.push("name", input.name);
      if (input.mute !== undefined) fields.push("mute", input.mute);
      if (input.solo !== undefined) fields.push("solo", input.solo);
      if (!fields.length) throw new Error("Pass at least one of name, mute, or solo.");
      const rack = await this.requireRack(input);
      const chain = rack.chains[input.chainIndex];
      if (!chain) throw new Error(`Rack '${rack.name}' has ${rack.chains.length} chain(s); there is no chain ${input.chainIndex}.`);
      if (chain.name !== input.expectedChainName) throw new Error(`Chain safeguard failed: expected chain ${input.chainIndex} to be '${input.expectedChainName}', found '${chain.name}'.`);
      return { address: "/live/rack/set_chain", args: [...this.target(input), input.expectedRackName, oscInt(input.chainIndex), input.expectedChainName, ...fields], before: chain };
    }, async before => {
      const wanted = (chain: RackState["chains"][number] | undefined) => !!chain &&
        (input.name === undefined || chain.name === input.name.replace(/[\r\n]/g, " ").trim()) &&
        (input.mute === undefined || chain.mute === input.mute) && (input.solo === undefined || chain.solo === input.solo);
      const { value: after, settled } = await this.poll(() => this.rackState(input.trackKind ?? "track", input.trackIndex, input.path), rack => wanted(rack.chains[input.chainIndex]));
      if (!settled) throw new Error("Live did not show the chain as asked.");
      const { devices: _devices, ...chain } = after.chains[input.chainIndex];
      const { devices: _before, ...was } = before;
      return { rack: after.name, before: was, after: chain };
    });
  }

  setDrumPad(input: RackTarget & { expectedRackName: string; note: number | string; expectedPadName: string; mute?: boolean; solo?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    let note = -1;
    return this.change("set_drum_pad", input, input.dryRun ?? false, async () => {
      note = typeof input.note === "string" ? noteNameToMidi(input.note) : input.note;
      if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error("Pad note must be 0-127 or a note name such as C1.");
      const fields: OscArgument[] = [];
      if (input.mute !== undefined) fields.push("mute", input.mute);
      if (input.solo !== undefined) fields.push("solo", input.solo);
      if (!fields.length) throw new Error("Pass mute, solo, or both.");
      const rack = await this.requireRack(input);
      if (!rack.isDrumRack) throw new Error(`Rack '${rack.name}' is not a Drum Rack.`);
      const pad = rack.drumPads?.find(entry => entry.note === note);
      if (!pad) throw new Error(`No pad with a sound on note ${note} in '${rack.name}'. Read the pads with get_rack.`);
      if (pad.name !== input.expectedPadName) throw new Error(`Pad safeguard failed: expected pad ${note} to be '${input.expectedPadName}', found '${pad.name}'.`);
      return { address: "/live/rack/set_drum_pad", args: [...this.target(input), input.expectedRackName, oscInt(note), input.expectedPadName, ...fields], before: pad };
    }, async before => {
      const wanted = (rack: RackState) => {
        const pad = rack.drumPads?.find(entry => entry.note === note);
        return !!pad && (input.mute === undefined || pad.mute === input.mute) && (input.solo === undefined || pad.solo === input.solo);
      };
      const { value: after, settled } = await this.poll(() => this.rackState(input.trackKind ?? "track", input.trackIndex, input.path), wanted);
      if (!settled) throw new Error("Live did not show the pad as asked.");
      return { rack: after.name, before, after: after.drumPads!.find(entry => entry.note === note) };
    });
  }

  rackVariation(input: RackTarget & { expectedRackName: string; action: "store" | "recall" | "delete" | "randomize"; variationIndex?: number; confirm?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("rack_variation", input, input.dryRun ?? false, async () => {
      const needsIndex = input.action === "recall" || input.action === "delete";
      if (needsIndex) nonNegativeInteger(input.variationIndex ?? -1, "variationIndex");
      const rack = await this.requireRack(input);
      if (!rack.variations) throw new Error("Macro variations need Live 11 or newer.");
      if (needsIndex && input.variationIndex! >= rack.variations.count) throw new Error(`Rack '${rack.name}' has ${rack.variations.count} variation(s); there is no variation ${input.variationIndex}.`);
      if (input.action === "delete" && input.confirm !== true && !(input.dryRun ?? false)) throw new Error("Deleting a variation needs confirm=true.");
      return { address: "/live/rack/variation", args: [...this.target(input), input.expectedRackName, input.action, oscInt(needsIndex ? input.variationIndex! : -1)], before: rack };
    }, async before => {
      const expectedCount = before.variations!.count + (input.action === "store" ? 1 : input.action === "delete" ? -1 : 0);
      const changedMacros = (rack: RackState) => rack.macros.some((macro, index) => Math.abs(macro.value - (before.macros[index]?.value ?? macro.value)) > VALUE_TOLERANCE);
      const done = (rack: RackState) => rack.variations!.count === expectedCount && (input.action !== "randomize" || changedMacros(rack));
      const { value: after, settled } = await this.poll(() => this.rackState(input.trackKind ?? "track", input.trackIndex, input.path), done);
      // Randomize can leave a macro where it was by chance; only the count is a firm check.
      if (!settled && !(input.action === "randomize" && after.variations!.count === expectedCount)) throw new Error(`Rack '${after.name}' shows ${after.variations!.count} variation(s), expected ${expectedCount}.`);
      return { rack: after.name, action: input.action, variations: after.variations, macros: after.macros };
    });
  }

  setDeviceParameterAtPath(input: RackTarget & { expectedDeviceName: string; parameterIndex: number; expectedParameterName: string; value: number; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("set_device_parameter_at_path", input, input.dryRun ?? false, async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.parameterIndex, "Parameter index");
      checkPath(input.path);
      this.requireTrackName(await this.trackNameOf(input.trackKind ?? "track", input.trackIndex), input.expectedTrackName);
      const device = await this.pathParameters(input.trackKind ?? "track", input.trackIndex, input.path);
      if (device.name !== input.expectedDeviceName) throw new Error(`Device safeguard failed: expected the device at ${input.path} to be '${input.expectedDeviceName}', found '${device.name}'.`);
      const parameter = device.parameters[input.parameterIndex];
      if (!parameter) throw new Error(`Device '${device.name}' has ${device.parameters.length} parameters; there is no parameter ${input.parameterIndex}.`);
      if (parameter.name !== input.expectedParameterName) throw new Error(`Parameter safeguard failed: expected parameter ${input.parameterIndex} to be '${input.expectedParameterName}', found '${parameter.name}'.`);
      if (!Number.isFinite(input.value) || input.value < parameter.min || input.value > parameter.max) throw new Error(`'${parameter.name}' must be from ${parameter.min} to ${parameter.max}.`);
      return { address: "/live/device_path/set_parameter", args: [...this.target(input), input.expectedDeviceName, oscInt(input.parameterIndex), input.expectedParameterName, oscFloat(input.value)], before: parameter };
    }, async before => {
      const read = async () => (await this.pathParameters(input.trackKind ?? "track", input.trackIndex, input.path)).parameters[input.parameterIndex];
      const { value: after, settled } = await this.poll(read, parameter => Math.abs(parameter.value - input.value) <= (before.quantized ? 0.5 : VALUE_TOLERANCE));
      if (!settled) throw new Error(`'${before.name}' reads ${after.value} (${after.display}), not ${input.value}.`);
      return { device: input.expectedDeviceName, path: input.path, before, after };
    });
  }
}
