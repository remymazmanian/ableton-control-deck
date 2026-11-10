import { describe, expect, it, vi } from "vitest";
import { DEVICE_PATH, RackTools, type RackState } from "../src/rack-tools.js";

const logger = { write: vi.fn() };
const plain = (args: unknown[] = []) => args.map(a => (a !== null && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : a));

function fakeRack() {
  const macro = (index: number, name: string, value = 0) => ({ index, name, value, min: 0, max: 127, display: String(value), quantized: false });
  const rack: RackState = {
    path: "0", name: "Keys Rack", className: "InstrumentGroupDevice", isDrumRack: false, visibleMacroCount: 8,
    macros: [macro(1, "Cutoff"), macro(2, "Drive"), ...[3, 4, 5, 6, 7, 8].map(n => macro(n, `Macro ${n}`))],
    chains: [
      { index: 0, name: "Piano", mute: false, solo: false, devices: [{ path: "0/0/0", name: "Simpler", className: "OriginalSimpler", enabled: true, isRack: false }] },
      { index: 1, name: "Pad", mute: false, solo: false, devices: [{ path: "0/1/0", name: "Drift", className: "Drift", enabled: true, isRack: false }] }
    ],
    variations: { count: 0, selected: -1 }
  };
  const drums: RackState = {
    path: "0", name: "Drum Rack", className: "DrumGroupDevice", isDrumRack: true, visibleMacroCount: 8, macros: rack.macros.map(entry => ({ ...entry })), chains: [],
    variations: { count: 0, selected: -1 }, drumPads: [{ note: 36, name: "Kick", mute: false, solo: false, chainCount: 1 }]
  };
  const drift = { path: "0/1/0", name: "Drift", className: "Drift", parameters: [{ index: 0, name: "Device On", value: 1, min: 0, max: 1, display: "On", quantized: true }, { index: 1, name: "Cutoff", value: 0.5, min: 0, max: 1, display: "50%", quantized: false }] };
  const sent: Array<{ address: string; args: unknown[] }> = [];
  const client = {
    rack, drums, drift, sent,
    send: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      sent.push({ address, args });
      const target = args[1] === 1 ? drums : rack;
      if (address === "/live/rack/set_macros") for (let i = 5; i < args.length; i += 2) target.macros.find(entry => entry.index === args[i])!.value = Number(args[i + 1]);
      if (address === "/live/rack/set_chain") {
        const chain = target.chains[Number(args[5])];
        for (let i = 7; i < args.length; i += 2) (chain as Record<string, unknown>)[String(args[i])] = args[i + 1];
      }
      if (address === "/live/rack/set_drum_pad") {
        const pad = target.drumPads!.find(entry => entry.note === args[5])!;
        for (let i = 7; i < args.length; i += 2) (pad as Record<string, unknown>)[String(args[i])] = args[i + 1];
      }
      if (address === "/live/rack/variation") {
        if (args[5] === "store") target.variations!.count += 1;
        if (args[5] === "delete") target.variations!.count -= 1;
        if (args[5] === "randomize") target.macros.forEach(entry => { entry.value = 64; });
      }
      if (address === "/live/device_path/set_parameter") drift.parameters[Number(args[5])].value = Number(args[7]);
    }),
    query: vi.fn(async (address: string, raw: unknown[] = []) => {
      const args = plain(raw);
      if (address === "/live/devices/get/state") return { args: [args[0], args[1], args[1] === 1 ? "Beats" : "Keys", 1, "Rack", "Rack", true] };
      if (address === "/live/rack/get") {
        if (args[2] !== "0") throw new Error(`Device at path '${String(args[2])}' is not a rack`);
        return { args: [JSON.stringify(args[1] === 1 ? drums : rack)] };
      }
      if (address === "/live/device_path/get/parameters") return { args: [JSON.stringify(drift)] };
      throw new Error(`Unexpected query ${address}`);
    })
  };
  return client;
}

const keys = { trackIndex: 0, expectedTrackName: "Keys", path: "0", expectedRackName: "Keys Rack" };

describe("rack tools", () => {
  it("accepts device paths of a device, or device/chain/device", () => {
    expect(["0", "3", "0/2/1", "0/0/1/0/0"].every(path => DEVICE_PATH.test(path))).toBe(true);
    expect(["", "0/1", "a", "0/1/", "/0"].some(path => DEVICE_PATH.test(path))).toBe(false);
  });

  it("reads a rack", async () => {
    const result = await new RackTools(fakeRack() as never, logger as never).getRack({ trackIndex: 0, path: "0" });
    expect(result).toMatchObject({ ok: true, data: { name: "Keys Rack", chains: [{ name: "Piano" }, { name: "Pad" }], macros: expect.arrayContaining([expect.objectContaining({ index: 1, name: "Cutoff" })]) } });
  });

  it("sets macros in one command and reads them back", async () => {
    const live = fakeRack();
    const result = await new RackTools(live as never, logger as never).setRackMacros({ ...keys, macros: [{ macro: 1, value: 100 }, { macro: 2, value: 30 }] });
    expect(live.sent).toEqual([{ address: "/live/rack/set_macros", args: ["track", 0, "Keys", "0", "Keys Rack", 1, 100, 2, 30] }]);
    expect(result).toMatchObject({ ok: true, data: { macros: [{ name: "Cutoff", value: 100 }, { name: "Drive", value: 30 }] } });
  });

  it("refuses a macro out of range, a hidden macro, or a stale rack name without sending", async () => {
    const live = fakeRack();
    const tools = new RackTools(live as never, logger as never);
    expect(await tools.setRackMacros({ ...keys, macros: [{ macro: 1, value: 200 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/from 0 to 127/) } });
    expect(await tools.setRackMacros({ ...keys, macros: [{ macro: 12, value: 1 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/shows 8 macros/) } });
    expect(await tools.setRackMacros({ ...keys, expectedRackName: "Bass Rack", macros: [{ macro: 1, value: 1 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'Keys Rack'/) } });
    expect(await tools.setRackMacros({ ...keys, path: "0/1", macros: [{ macro: 1, value: 1 }] })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/device\/chain\/device/) } });
    expect(live.send).not.toHaveBeenCalled();
  });

  it("renames and mutes a chain by its current name", async () => {
    const live = fakeRack();
    const tools = new RackTools(live as never, logger as never);
    const result = await tools.setRackChain({ ...keys, chainIndex: 1, expectedChainName: "Pad", name: "Strings", mute: true });
    expect(result).toMatchObject({ ok: true, data: { before: { name: "Pad", mute: false }, after: { name: "Strings", mute: true } } });
    expect(await tools.setRackChain({ ...keys, chainIndex: 0, expectedChainName: "Organ", solo: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'Piano'/) } });
  });

  it("mutes a drum pad by note name and refuses a pad with no sound", async () => {
    const live = fakeRack();
    const tools = new RackTools(live as never, logger as never);
    const drums = { trackIndex: 1, expectedTrackName: "Beats", path: "0", expectedRackName: "Drum Rack" };
    expect(await tools.setDrumPad({ ...drums, note: "C1", expectedPadName: "Kick", mute: true })).toMatchObject({ ok: true, data: { after: { note: 36, mute: true } } });
    expect(await tools.setDrumPad({ ...drums, note: 37, expectedPadName: "", mute: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No pad with a sound on note 37/) } });
    expect(await tools.setDrumPad({ ...keys, note: 36, expectedPadName: "Kick", mute: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not a Drum Rack/) } });
  });

  it("stores, randomizes, and deletes variations, deleting only with confirm", async () => {
    const live = fakeRack();
    const tools = new RackTools(live as never, logger as never);
    expect(await tools.rackVariation({ ...keys, action: "store" })).toMatchObject({ ok: true, data: { variations: { count: 1 } } });
    expect(await tools.rackVariation({ ...keys, action: "randomize" })).toMatchObject({ ok: true, data: { macros: expect.arrayContaining([expect.objectContaining({ index: 1, value: 64 })]) } });
    expect(await tools.rackVariation({ ...keys, action: "recall", variationIndex: 4 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/no variation 4/) } });
    expect(await tools.rackVariation({ ...keys, action: "delete", variationIndex: 0 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/confirm=true/) } });
    expect(await tools.rackVariation({ ...keys, action: "delete", variationIndex: 0, confirm: true })).toMatchObject({ ok: true, data: { variations: { count: 0 } } });
  });

  it("sets a nested device parameter by path and current names", async () => {
    const live = fakeRack();
    const tools = new RackTools(live as never, logger as never);
    const target = { trackIndex: 0, expectedTrackName: "Keys", path: "0/1/0", expectedDeviceName: "Drift" };
    expect(await tools.setDeviceParameterAtPath({ ...target, parameterIndex: 1, expectedParameterName: "Cutoff", value: 0.25 })).toMatchObject({ ok: true, data: { before: { value: 0.5 }, after: { value: 0.25 } } });
    expect(await tools.setDeviceParameterAtPath({ ...target, parameterIndex: 1, expectedParameterName: "Resonance", value: 0.25 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/found 'Cutoff'/) } });
    expect(await tools.setDeviceParameterAtPath({ ...target, parameterIndex: 1, expectedParameterName: "Cutoff", value: 4 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/from 0 to 1/) } });
  });
});
