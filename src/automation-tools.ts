import { MeterTools } from "./meter-tools.js";
import { chunkOscNotes } from "./note-chunks.js";
import { nonNegativeInteger } from "./session-tools.js";
import { oscFloat, oscInt, type OscArgument, type ToolResult } from "./types.js";

/** A parameter on the clip's own track: its mixer, or a device (including inside racks) by path. */
export type AutomationParameter =
  | { kind: "mixer"; field: "volume" | "panning" | "send"; sendIndex?: number }
  | { kind: "device"; path: string; parameterIndex: number; name: string };

export interface AutomationPoint { time: number; value?: number; db?: number | "-inf" }
/** A step holds one value over [time, time + duration). A dB step is converted to a value in Live. */
export interface AutomationStep { time: number; duration: number; value: number; isDb: boolean; db?: number | "-inf" }

const DEFAULT_RESOLUTION = 0.125;
const MAX_STEPS = 4096;
const STEPS_PER_COMMAND = 256;
const TOLERANCE = 1e-3;

/**
 * Turn points into envelope steps. "steps" holds each point's value until the next point (the last
 * holds to the clip end). "ramp" moves linearly between points in steps of `resolution` beats.
 * dB points only make sense for steps, since dB is converted in Live per value.
 */
export function planSteps(points: readonly AutomationPoint[], lengthBeats: number, shape: "steps" | "ramp", resolution = DEFAULT_RESOLUTION): AutomationStep[] {
  if (!points.length) throw new Error("Pass at least one point.");
  if (!Number.isFinite(resolution) || resolution < 1 / 64 || resolution > 4) throw new Error("resolution must be from 1/64 to 4 beats.");
  const sorted = [...points].sort((a, b) => a.time - b.time);
  for (const [index, point] of sorted.entries()) {
    if (!Number.isFinite(point.time) || point.time < 0 || point.time >= lengthBeats) throw new Error(`Point time ${point.time} must be from 0 to before the clip's end at ${lengthBeats} beats.`);
    if ((point.value === undefined) === (point.db === undefined)) throw new Error("Each point needs exactly one of value or db.");
    if (index > 0 && Math.abs(point.time - sorted[index - 1].time) < 1e-9) throw new Error(`Two points share time ${point.time}.`);
  }
  const usesDb = sorted.some(point => point.db !== undefined);
  if (usesDb && sorted.some(point => point.value !== undefined)) throw new Error("Use value for every point or db for every point, not both.");
  if (usesDb && shape === "ramp") throw new Error("A ramp needs value points; use db with shape \"steps\", or give the ramp in Live's 0-1 values.");
  const steps: AutomationStep[] = [];
  for (const [index, point] of sorted.entries()) {
    const end = index + 1 < sorted.length ? sorted[index + 1].time : lengthBeats;
    if (shape === "steps" || index + 1 === sorted.length) {
      steps.push(usesDb ? { time: point.time, duration: end - point.time, value: 0, isDb: true, db: point.db } : { time: point.time, duration: end - point.time, value: point.value!, isDb: false });
      continue;
    }
    const next = sorted[index + 1];
    const count = Math.max(1, Math.ceil((end - point.time) / resolution - 1e-9));
    for (let k = 0; k < count; k++) {
      const time = point.time + k * resolution;
      const duration = Math.min(resolution, end - time);
      const value = point.value! + ((next.value! - point.value!) * k) / count;
      steps.push({ time, duration, value, isDb: false });
    }
  }
  if (steps.length > MAX_STEPS) throw new Error(`That would write ${steps.length} steps; the limit is ${MAX_STEPS}. Use a coarser resolution.`);
  return steps;
}

interface ClipTargetInput { trackIndex: number; sceneIndex: number; expectedTrackName: string; expectedClipName: string }

export class AutomationTools extends MeterTools {
  /** Sample an envelope: an even spread of `samples` points, or the value at each exact time. */
  private async automation(trackIndex: number, sceneIndex: number, parameter: AutomationParameter, samples: number | number[]) {
    const how: OscArgument = Array.isArray(samples) ? JSON.stringify(samples) : oscInt(samples);
    const reply = await this.live.query("/live/clip_automation/get", [oscInt(trackIndex), oscInt(sceneIndex), JSON.stringify(parameter), how]);
    return JSON.parse(String(reply.args[0])) as { parameter: string; min: number; max: number; lengthBeats: number; hasEnvelope: boolean; samples: Array<{ time: number; value: number; display: string | null }> };
  }

  getClipAutomation(input: { trackIndex: number; sceneIndex: number; parameter?: AutomationParameter; samples?: number }): Promise<ToolResult> {
    return this.read("get_clip_automation", async () => {
      nonNegativeInteger(input.trackIndex, "Track index");
      nonNegativeInteger(input.sceneIndex, "Scene index");
      if (!input.parameter) {
        const reply = await this.live.query("/live/clip_automation/list", [oscInt(input.trackIndex), oscInt(input.sceneIndex)]);
        return JSON.parse(String(reply.args[0]));
      }
      return this.automation(input.trackIndex, input.sceneIndex, input.parameter, input.samples ?? 33);
    });
  }

  writeClipAutomation(input: ClipTargetInput & { parameter: AutomationParameter; points: AutomationPoint[]; shape?: "steps" | "ramp"; resolution?: number; clearFirst?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    const shape = input.shape ?? "steps";
    let steps: AutomationStep[] = [];
    return this.change("write_clip_automation", input, input.dryRun ?? false, async () => {
      await this.requireClip(input);
      const current = await this.automation(input.trackIndex, input.sceneIndex, input.parameter, 2);
      steps = planSteps(input.points, current.lengthBeats, shape, input.resolution);
      if (input.parameter.kind === "device" || input.parameter.field === "panning") {
        if (steps.some(step => step.isDb)) throw new Error("db points only apply to volume and sends.");
      }
      for (const step of steps) if (!step.isDb && (step.value < current.min - 1e-6 || step.value > current.max + 1e-6)) throw new Error(`${current.parameter} must be from ${current.min} to ${current.max}; ${step.value} is outside that.`);
      const address = "/live/clip_automation/write";
      const prefix = (clear: boolean): OscArgument[] => [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName, JSON.stringify(input.parameter), clear];
      const encode = (step: AutomationStep): OscArgument[] => [oscFloat(step.time), oscFloat(step.duration), step.isDb ? (step.db === "-inf" ? "-inf" : oscFloat(Number(step.db))) : oscFloat(step.value), step.isDb];
      // A long ramp is many steps; split it into commands that each fit one datagram. Only the first clears.
      const chunks = chunkOscNotes(this.live, steps, { address, prefix: prefix(input.clearFirst ?? false), encode, maxPerChunk: STEPS_PER_COMMAND });
      const [first, ...rest] = chunks.map((chunk, index) => [...prefix(index === 0 && (input.clearFirst ?? false)), ...chunk.flatMap(encode)]);
      return { address, args: first, before: current, moreBatches: rest };
    }, async () => {
      // Read the envelope back at each step's start and compare the values that are known up front.
      const after = await this.automation(input.trackIndex, input.sceneIndex, input.parameter, 2);
      if (!after.hasEnvelope) throw new Error("Live shows no envelope for that parameter after writing.");
      // Check every known value at a point just inside its step, in one query.
      const checks = steps.filter(step => !step.isDb).slice(0, 512);
      const read = checks.length ? (await this.automation(input.trackIndex, input.sceneIndex, input.parameter, checks.map(step => step.time + Math.min(step.duration / 2, 0.01)))).samples : [];
      const mismatches: string[] = [];
      checks.forEach((step, index) => {
        const value = read[index]?.value;
        if (value === undefined || Math.abs(value - step.value) > TOLERANCE * Math.max(1, Math.abs(after.max - after.min))) mismatches.push(`at beat ${step.time} it reads ${value}, not ${step.value}`);
      });
      if (mismatches.length) throw new Error(`Automation read-back failed: ${mismatches.slice(0, 3).join("; ")}.`);
      const sampled = await this.automation(input.trackIndex, input.sceneIndex, input.parameter, 17);
      return { parameter: sampled.parameter, shape, steps: steps.length, checked: checks.length, lengthBeats: sampled.lengthBeats, samples: sampled.samples };
    });
  }

  clearClipAutomation(input: ClipTargetInput & { parameter?: AutomationParameter; all?: boolean; confirm?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.change("clear_clip_automation", input, input.dryRun ?? false, async () => {
      if (!!input.parameter === !!input.all) throw new Error("Pass a parameter, or all: true.");
      if (input.all && input.confirm !== true && !(input.dryRun ?? false)) throw new Error("Clearing all of a clip's automation needs confirm=true.");
      await this.requireClip(input);
      const before = JSON.parse(String((await this.live.query("/live/clip_automation/list", [oscInt(input.trackIndex), oscInt(input.sceneIndex)])).args[0]));
      return { address: "/live/clip_automation/clear", args: [oscInt(input.trackIndex), oscInt(input.sceneIndex), input.expectedTrackName, input.expectedClipName, input.all ? "all" : JSON.stringify(input.parameter), input.confirm === true], before };
    }, async before => {
      const after = JSON.parse(String((await this.live.query("/live/clip_automation/list", [oscInt(input.trackIndex), oscInt(input.sceneIndex)])).args[0]));
      if (input.all && after.automated.length) throw new Error(`The clip still automates ${after.automated.length} parameter(s).`);
      if (input.parameter) {
        const left = await this.automation(input.trackIndex, input.sceneIndex, input.parameter, 2);
        if (left.hasEnvelope) throw new Error("Live still shows an envelope for that parameter.");
      }
      return { cleared: input.all ? before.automated.length : 1, automated: after.automated };
    });
  }
}
