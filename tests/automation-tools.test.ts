import { describe, expect, it, vi } from "vitest";
import { AutomationTools, planSteps } from "../src/automation-tools.js";

describe("planSteps", () => {
  it("holds each point until the next, and the last until the clip end", () => {
    expect(planSteps([{ time: 8, value: 0.9 }, { time: 0, value: 0.2 }], 16, "steps")).toEqual([
      { time: 0, duration: 8, value: 0.2, isDb: false },
      { time: 8, duration: 8, value: 0.9, isDb: false }
    ]);
  });

  it("ramps linearly between points at the resolution, reaching the next value on its point", () => {
    const steps = planSteps([{ time: 0, value: 0 }, { time: 1, value: 1 }], 2, "ramp", 0.25);
    expect(steps.map(step => [step.time, step.value])).toEqual([[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]]);
    expect(steps.at(-1)).toMatchObject({ duration: 1 });
  });

  it("refuses bad points", () => {
    expect(() => planSteps([], 4, "steps")).toThrow(/at least one point/);
    expect(() => planSteps([{ time: 4, value: 0 }], 4, "steps")).toThrow(/before the clip's end/);
    expect(() => planSteps([{ time: 0 }], 4, "steps")).toThrow(/exactly one of value or db/);
    expect(() => planSteps([{ time: 0, value: 0 }, { time: 0, value: 1 }], 4, "steps")).toThrow(/share time/);
    expect(() => planSteps([{ time: 0, db: -6 }, { time: 1, value: 0.5 }], 4, "steps")).toThrow(/not both/);
    expect(() => planSteps([{ time: 0, db: -6 }, { time: 1, db: 0 }], 4, "ramp")).toThrow(/ramp needs value points/);
    expect(() => planSteps([{ time: 0, value: 0 }, { time: 600, value: 1 }], 601, "ramp", 1 / 64)).toThrow(/limit is 4096/);
  });
});

function fakeLive() {
  // One envelope keyed by parameter JSON: a list of [start, end, value] steps, with Live's default of 0.85.
  const envelopes = new Map<string, Array<[number, number, number]>>();
  const at = (steps: Array<[number, number, number]>, time: number) => steps.reduce((value, [start, end, v]) => (start <= time && time < end ? v : value), 0.85);
  const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));
  const sent: unknown[][] = [];
  return {
    envelopes, sent,
    send: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      sent.push([address, ...args]);
      if (address === "/live/clip_automation/write") {
        const key = String(args[4]);
        const steps = args[5] === true ? [] : envelopes.get(key) ?? [];
        for (let k = 6; k < args.length; k += 4) steps.push([Number(args[k]), Number(args[k]) + Number(args[k + 1]), args[k + 3] === true ? 0.7 : Number(args[k + 2])]);
        envelopes.set(key, steps);
      }
      if (address === "/live/clip_automation/clear") {
        if (args[4] === "all") envelopes.clear(); else envelopes.delete(String(args[4]));
      }
    }),
    query: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      if (address === "/live/song/get/track_names") return { args: ["Keys"] };
      if (address === "/live/clip_slot/get/state") return { args: [0, 0, true, "Pad", false, false, false] };
      if (address === "/live/clip_automation/list") return { args: [JSON.stringify({ lengthBeats: 16, automated: [...envelopes.keys()].map(key => JSON.parse(key)) })] };
      if (address === "/live/clip_automation/get") {
        const key = String(args[2]);
        const steps = envelopes.get(key);
        const times = typeof args[3] === "string" ? (JSON.parse(args[3]) as number[]) : Array.from({ length: Number(args[3]) }, (_, k) => (16 * k) / (Number(args[3]) - 1));
        return { args: [JSON.stringify({ parameter: "Volume", min: 0, max: 1, lengthBeats: 16, hasEnvelope: !!steps, samples: steps ? times.map(time => ({ time, value: at(steps, time), display: null })) : [] })] };
      }
      throw new Error(`Unexpected query ${address}`);
    })
  };
}

const pad = { trackIndex: 0, sceneIndex: 0, expectedTrackName: "Keys", expectedClipName: "Pad" };
const volume = { kind: "mixer" as const, field: "volume" as const };
const logger = { write: vi.fn() };

describe("write_clip_automation", () => {
  it("writes a ramp, splitting a long one into several commands, and reads every step back", async () => {
    const live = fakeLive();
    const result = await new AutomationTools(live as never, logger as never).writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 0, value: 0 }, { time: 15.5, value: 1 }], shape: "ramp", resolution: 1 / 32 });
    expect(result).toMatchObject({ ok: true, data: { shape: "ramp" } });
    expect((result.data as { steps: number }).steps).toBe(497);
    expect(live.sent.length).toBeGreaterThan(1);
    expect(live.sent.every(command => command[0] === "/live/clip_automation/write")).toBe(true);
  });

  it("clears first only on the first command when asked", async () => {
    const live = fakeLive();
    const tools = new AutomationTools(live as never, logger as never);
    await tools.writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 0, value: 0.3 }] });
    await tools.writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 8, value: 0.6 }], clearFirst: true });
    expect(live.envelopes.get(JSON.stringify(volume))).toEqual([[8, 16, 0.6]]);
  });

  it("refuses an out-of-range value or a stale clip name without sending", async () => {
    const live = fakeLive();
    const tools = new AutomationTools(live as never, logger as never);
    expect(await tools.writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 0, value: 1.5 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/from 0 to 1/) } });
    expect(await tools.writeClipAutomation({ ...pad, expectedClipName: "Lead", parameter: volume, points: [{ time: 0, value: 0.5 }] })).toMatchObject({ ok: false });
    expect(await tools.writeClipAutomation({ ...pad, parameter: { kind: "mixer", field: "panning" }, points: [{ time: 0, db: -6 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/only apply to volume and sends/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("fails when Live does not hold the value written", async () => {
    const live = fakeLive();
    live.send.mockImplementation(async () => undefined);
    live.envelopes.set(JSON.stringify(volume), []);
    const result = await new AutomationTools(live as never, logger as never).writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 0, value: 0.2 }] });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/read-back failed: at beat 0 it reads 0.85, not 0.2/) } });
  });
});

describe("clear_clip_automation", () => {
  it("clears one envelope, and all only with confirm", async () => {
    const live = fakeLive();
    const tools = new AutomationTools(live as never, logger as never);
    await tools.writeClipAutomation({ ...pad, parameter: volume, points: [{ time: 0, value: 0.3 }] });
    expect(await tools.clearClipAutomation({ ...pad, all: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(await tools.clearClipAutomation({ ...pad, parameter: volume })).toMatchObject({ ok: true, data: { cleared: 1, automated: [] } });
    expect(await tools.clearClipAutomation({ ...pad })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/a parameter, or all/) } });
  });
});
