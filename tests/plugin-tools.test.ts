import { describe, expect, it, vi } from "vitest";
import { AbletonBridgeError, parseBridgeDatagram, BRIDGE_PROTOCOL } from "../src/ableton-client.js";
import { PluginTools } from "../src/plugin-tools.js";

const logger = { write: vi.fn() };

describe("Control Deck protocol", () => {
  it("parses correlated JSON responses and chunk envelopes", () => {
    const response = parseBridgeDatagram(Buffer.from(JSON.stringify({ protocol: BRIDGE_PROTOCOL, id: "abc", ok: true, result: { version: "1.0.0" } })));
    expect(response).toMatchObject({ id: "abc", ok: true });
    const chunk = parseBridgeDatagram(Buffer.from(JSON.stringify({ protocol: BRIDGE_PROTOCOL, id: "abc", chunk: { index: 2, total: 3, encoding: "base64" }, payload: "c2Vjb25k" })));
    expect(chunk).toMatchObject({ id: "abc", chunk: { index: 2, total: 3 } });
  });
});

describe("plugin tools", () => {
  it("parses filtered Live Browser listings", async () => {
    const bridge = { listPlugins: vi.fn().mockResolvedValue({ returned: 2, matched: 2, truncated: false, offset: 0, limit: 10, plugins: [
      { name: "Pro-Q 4", path: "Plugins/VST3/FabFilter/Pro-Q 4", format: "vst3" },
      { name: "Diva", path: "Plugins/VST3/u-he/Diva", format: "vst3" }
    ] }) };
    const result = await new PluginTools(bridge as never, {} as never, logger as never).listInstalledPlugins({ query: "", format: "vst3", limit: 10 });
    expect(result).toMatchObject({ ok: true, data: { returned: 2, plugins: [
      { name: "Pro-Q 4", format: "vst3" }, { name: "Diva", format: "vst3" }
    ] } });
    expect(bridge.listPlugins).toHaveBeenCalledWith({ query: "", format: "vst3", limit: 10, offset: 0 });
  });

  it("dry-runs only after track and exact-path safeguards pass", async () => {
    const bridge = { resolvePlugin: vi.fn().mockResolvedValue({ plugin: { name: "Diva", path: "Plugins/VST3/u-he/Diva", format: "vst3" } }) };
    const osc = { query: vi.fn().mockResolvedValue({ args: ["Synth"] }) };
    const result = await new PluginTools(bridge as never, osc as never, logger as never).loadPlugin({ trackIndex: 0, expectedTrackName: "Synth", name: "Diva", format: "vst3", expectedPath: "Plugins/VST3/u-he/Diva", dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, data: { resolved: { name: "Diva" } } });
    expect(bridge.resolvePlugin).toHaveBeenCalledWith("Diva", "vst3", "Plugins/VST3/u-he/Diva");
  });

  it("loads once and verifies the new device through Control Deck live control", async () => {
    let loaded = false;
    const bridge = {
      resolvePlugin: vi.fn().mockResolvedValue({ plugin: { name: "Pro-Q 4", path: "Plugins/VST3/FabFilter/Pro-Q 4", format: "vst3" } }),
      loadPlugin: vi.fn(async () => { loaded = true; return { loaded: { name: "Pro-Q 4" }, selectionRestored: true }; })
    };
    const osc = { query: vi.fn(async (address: string) => {
      if (address.endsWith("track_names")) return { args: ["Test Audio"] };
      if (address.endsWith("devices/name")) return { args: loaded ? [0, "Pro-Q 4"] : [0] };
      if (address.endsWith("devices/class_name")) return { args: loaded ? [0, "PluginDevice"] : [0] };
      throw new Error(address);
    }) };
    const result = await new PluginTools(bridge as never, osc as never, logger as never).loadPlugin({ trackIndex: 0, expectedTrackName: "Test Audio", name: "Pro-Q 4", format: "vst3" });
    expect(result).toMatchObject({ ok: true, data: { deviceCountBefore: 0, deviceCountAfter: 1, newDevices: [{ name: "Pro-Q 4" }] } });
    expect(bridge.resolvePlugin).toHaveBeenCalledTimes(1);
    expect(bridge.loadPlugin).toHaveBeenCalledTimes(1);
  });

  it("loads a User Library rack by exact name and reads the device chain back", async () => {
    let loaded = false;
    const bridge = {
      resolveUserLibraryItem: vi.fn(async () => ({ item: { name: "Serum Rack", path: "User Library/Presets/Instruments/Serum Rack", kind: "user-device" } })),
      loadUserDevice: vi.fn(async () => { loaded = true; return { loaded: { name: "Serum Rack" } }; })
    };
    const osc = { query: vi.fn(async (address: string) => {
      if (address.endsWith("track_names")) return { args: ["Bass"] };
      if (address.endsWith("selected_track")) return { args: [0] };
      if (address.endsWith("devices/name")) return { args: loaded ? [0, "Serum Rack"] : [0] };
      if (address.endsWith("devices/class_name")) return { args: loaded ? [0, "InstrumentGroupDevice"] : [0] };
      throw new Error(address);
    }) };
    const result = await new PluginTools(bridge as never, osc as never, logger as never).loadUserLibraryItem({ trackIndex: 0, expectedTrackName: "Bass", name: "Serum Rack" });
    expect(result).toMatchObject({ ok: true, data: { deviceCountBefore: 0, deviceCountAfter: 1, devicesAfter: [{ name: "Serum Rack", className: "InstrumentGroupDevice" }], resolved: { path: "User Library/Presets/Instruments/Serum Rack" } } });
    expect(bridge.loadUserDevice).toHaveBeenCalledTimes(1);
  });

  it("refuses an ambiguous User Library name and a filesystem preset path", async () => {
    const bridge = {
      resolveUserLibraryItem: vi.fn(async () => { throw new AbletonBridgeError("USER_DEVICE_AMBIGUOUS", "Multiple User Library devices are named 'Pad'", { paths: ["User Library/Pads/Pad", "User Library/Leads/Pad"] }); }),
      loadUserDevice: vi.fn()
    };
    const osc = { query: vi.fn(async (address: string) => address.endsWith("track_names") ? { args: ["Bass"] } : { args: [] }) };
    const tools = new PluginTools(bridge as never, osc as never, logger as never);
    const ambiguous = await tools.loadUserLibraryItem({ trackIndex: 0, expectedTrackName: "Bass", name: "Pad" });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "USER_DEVICE_AMBIGUOUS", details: { paths: ["User Library/Pads/Pad", "User Library/Leads/Pad"] } } });
    expect(bridge.loadUserDevice).not.toHaveBeenCalled();
    await expect(tools.loadUserLibraryItem({ trackIndex: 0, expectedTrackName: "Bass", name: "Bass", path: "/Users/remy/Library/Audio/Presets/Serum 2/Bass.vstpreset" })).rejects.toThrow(/not a file on disk/);
    expect(bridge.resolveUserLibraryItem).toHaveBeenCalledTimes(1);
  });

  it("rejects a shifted or renamed target before calling Control Deck", async () => {
    const bridge = { resolvePlugin: vi.fn(), loadPlugin: vi.fn() };
    const osc = { query: vi.fn().mockResolvedValue({ args: ["Wrong Track"] }) };
    const tools = new PluginTools(bridge as never, osc as never, logger as never);
    await expect(tools.loadPlugin({ trackIndex: 0, expectedTrackName: "Expected", name: "Diva", format: "vst3" })).rejects.toThrow(/safeguard/);
    expect(bridge.resolvePlugin).not.toHaveBeenCalled();
    expect(bridge.loadPlugin).not.toHaveBeenCalled();
  });
});
