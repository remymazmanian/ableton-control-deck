import { JsonLogger } from "./logger.js";
import type { AbletonClient, AbletonPlugin } from "./ableton-client.js";
import { oscInt, type LiveControlClient, type ToolResult } from "./types.js";

export type PluginFormat = "vst3" | "vst2" | "au" | "auv2";
interface ResolvedPlugin extends AbletonPlugin {}

export class PluginTools {
  constructor(private readonly bridge: AbletonClient, private readonly live: LiveControlClient, private readonly logger = new JsonLogger(), private readonly defaultDryRun = false) {}

  async status(): Promise<ToolResult> {
    return this.read("plugin_loader_status", async () => {
      const status = await this.bridge.status();
      return { connected: true, ...status };
    });
  }

  async listInstalledPlugins(input: { query?: string; format?: PluginFormat; limit?: number }): Promise<ToolResult> {
    return this.read("list_installed_plugins", async () => {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      return this.bridge.listPlugins({ query: input.query, format: input.format, limit, offset: 0 });
    });
  }

  async findPlugin(name: string, format: PluginFormat): Promise<ToolResult> {
    return this.read("find_plugin", async () => ({ plugin: await this.resolve(name, format) }));
  }

  async refreshPluginIndex(): Promise<ToolResult> {
    return this.read("refresh_plugin_index", async () => this.bridge.refreshPlugins());
  }

  async loadPlugin(input: { trackIndex: number; expectedTrackName: string; name: string; format: PluginFormat; expectedPath?: string; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.trackIndex) || input.trackIndex < 0) throw new Error("Track index must be a non-negative integer.");
    const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
    if (input.trackIndex >= trackNames.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
    if (trackNames[input.trackIndex] !== input.expectedTrackName) throw new Error(`Track safeguard failed: expected '${input.expectedTrackName}', found '${trackNames[input.trackIndex]}'.`);
    const resolved = await this.resolve(input.name, input.format, input.expectedPath);
    if (input.expectedPath && normalizePath(resolved.path) !== normalizePath(input.expectedPath)) throw new Error(`Plugin path safeguard failed: expected '${input.expectedPath}', resolved '${resolved.path}'.`);
    const bridgeRequest = { trackIndex: input.trackIndex, expectedTrackName: trackNames[input.trackIndex], name: resolved.name, format: resolved.format, path: resolved.path };
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = { ok: true, dryRun: true, tool: "load_plugin", data: { trackIndex: input.trackIndex, trackName: trackNames[input.trackIndex], resolved }, intendedOperations: [{ address: "bridge://plugins.load", args: [JSON.stringify(bridgeRequest)] }] };
      await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }

    const before = await this.getDevices(input.trackIndex);
    const selectedTrackBefore = await this.getSelectedTrackIndex();
    let acknowledgement: Record<string, unknown> | undefined;
    let acknowledgementError: string | undefined;
    try {
      acknowledgement = await this.bridge.loadPlugin(bridgeRequest);
    } catch (error) {
      acknowledgementError = error instanceof Error ? error.message : String(error);
    }

    const after = await this.waitForDeviceCount(input.trackIndex, before.length + 1);
    const selectionRestored = await this.restoreSelectedTrack(selectedTrackBefore, input.trackIndex);
    if (!after) {
      const message = acknowledgementError ?? `Live did not confirm a new device after the bridge response.`;
      await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: acknowledgement, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "load_plugin", data: { completedActions: acknowledgement ? ["Bridge load request acknowledged"] : [], incompleteActions: ["Bridge device-chain verification", ...(!selectionRestored ? ["Selected-track restoration"] : [])], acknowledgement, selectionRestored }, error: { code: "PLUGIN_LOAD_NOT_VERIFIED", message } };
    }
    const newDevices = after.slice(before.length);
    const result: ToolResult = { ok: true, dryRun: false, tool: "load_plugin", data: { trackIndex: input.trackIndex, trackName: trackNames[input.trackIndex], resolved, acknowledgement, acknowledgementReceived: Boolean(acknowledgement), acknowledgementError, newDevices, deviceCountBefore: before.length, deviceCountAfter: after.length, selectedTrackBefore, selectionRestored, warnings: selectionRestored ? [] : ["Plugin loaded, but the prior selected track could not be restored."] } };
    await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true });
    return result;
  }

  async findLiveDevice(name: string, path?: string): Promise<ToolResult> {
    return this.read("find_live_device", async () => this.bridge.resolveBrowserDevice(name, path));
  }

  async loadLiveDevice(input: { trackIndex: number; expectedTrackName: string; name: string; path?: string; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.trackIndex) || input.trackIndex < 0) throw new Error("Track index must be a non-negative integer.");
    const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
    if (input.trackIndex >= trackNames.length) throw new Error(`Track index ${input.trackIndex} does not exist.`);
    if (trackNames[input.trackIndex] !== input.expectedTrackName) throw new Error(`Track safeguard failed: expected '${input.expectedTrackName}', found '${trackNames[input.trackIndex]}'.`);
    const resolved = (await this.bridge.resolveBrowserDevice(input.name, input.path)).device;
    const bridgeRequest = { trackIndex: input.trackIndex, expectedTrackName: trackNames[input.trackIndex], name: resolved.name, path: resolved.path };
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = { ok: true, dryRun: true, tool: "load_live_device", data: { trackIndex: input.trackIndex, trackName: trackNames[input.trackIndex], resolved }, intendedOperations: [{ address: "bridge://devices.load_browser_item", args: [JSON.stringify(bridgeRequest)] }] };
      await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }

    const before = await this.getDevices(input.trackIndex);
    const selectedTrackBefore = await this.getSelectedTrackIndex();
    let acknowledgement: Record<string, unknown> | undefined;
    let acknowledgementError: string | undefined;
    try {
      acknowledgement = await this.bridge.loadBrowserDevice(bridgeRequest);
    } catch (error) {
      acknowledgementError = error instanceof Error ? error.message : String(error);
    }

    const after = await this.waitForDeviceCount(input.trackIndex, before.length + 1);
    const selectionRestored = await this.restoreSelectedTrack(selectedTrackBefore, input.trackIndex);
    if (!after) {
      const message = acknowledgementError ?? `Live did not confirm a new device after the bridge response.`;
      await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: acknowledgement, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "load_live_device", data: { completedActions: acknowledgement ? ["Bridge load request acknowledged"] : [], incompleteActions: ["Bridge device-chain verification", ...(!selectionRestored ? ["Selected-track restoration"] : [])], acknowledgement, selectionRestored }, error: { code: "DEVICE_LOAD_NOT_VERIFIED", message } };
    }
    const newDevices = after.slice(before.length);
    const result: ToolResult = { ok: true, dryRun: false, tool: "load_live_device", data: { trackIndex: input.trackIndex, trackName: trackNames[input.trackIndex], resolved, acknowledgement, acknowledgementReceived: Boolean(acknowledgement), acknowledgementError, newDevices, deviceCountBefore: before.length, deviceCountAfter: after.length, selectedTrackBefore, selectionRestored, warnings: selectionRestored ? [] : ["Device loaded, but the prior selected track could not be restored."] } };
    await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true });
    return result;
  }

  private async resolve(name: string, format: PluginFormat, expectedPath?: string): Promise<ResolvedPlugin> {
    return (await this.bridge.resolvePlugin(name, format, expectedPath)).plugin;
  }

  private async getDevices(trackIndex: number): Promise<Array<{ index: number; name: string; className: string }>> {
    const args = [oscInt(trackIndex)];
    const [names, classes] = await Promise.all([this.live.query("/live/track/get/devices/name", args), this.live.query("/live/track/get/devices/class_name", args)]);
    return names.args.slice(1).map((name, index) => ({ index, name: String(name), className: String(classes.args[index + 1]) }));
  }

  private async waitForDeviceCount(trackIndex: number, expected: number): Promise<Array<{ index: number; name: string; className: string }> | null> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const devices = await this.getDevices(trackIndex);
      if (devices.length >= expected) return devices;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  private async getSelectedTrackIndex(): Promise<number | undefined> {
    try { return Number((await this.live.query("/live/view/get/selected_track")).args.at(-1)); }
    catch { return undefined; }
  }

  private async restoreSelectedTrack(previous: number | undefined, target: number): Promise<boolean> {
    if (previous === undefined || previous === target) return true;
    try {
      await this.live.send("/live/view/set/selected_track", [oscInt(previous)]);
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await this.getSelectedTrackIndex() === previous) return true;
        await new Promise(resolve => setTimeout(resolve, 75));
      }
    } catch { return false; }
    return false;
  }

  private async read<T>(tool: string, operation: () => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    try {
      const data = await operation();
      await this.logger.write({ tool, response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "BRIDGE_ERROR";
      const details = (error as { details?: unknown })?.details;
      await this.logger.write({ tool, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool, error: { code, message, ...(details !== undefined ? { details } : {}) } };
    }
  }
}

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
