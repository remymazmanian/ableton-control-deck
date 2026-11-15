import { JsonLogger } from "./logger.js";
import type { AbletonClient, AbletonPlugin } from "./ableton-client.js";
import { oscInt, type LiveControlClient, type ToolResult } from "./types.js";

export type TrackKind = "track" | "return" | "master";
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

  async loadPlugin(input: { trackKind?: TrackKind; trackIndex: number; expectedTrackName: string; name: string; format: PluginFormat; expectedPath?: string; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.trackIndex) || input.trackIndex < 0) throw new Error("Track index must be a non-negative integer.");
    if (input.format === "vst2") throw new Error("Control Deck does not load VST2 plugins; use the VST3 or AU version.");
    const kind = input.trackKind ?? "track";
    const trackName = await this.requireTrackName(kind, input.trackIndex, input.expectedTrackName);
    const resolved = await this.resolve(input.name, input.format, input.expectedPath);
    if (resolved.format === "vst2") throw new Error(`'${resolved.name}' is a VST2 plugin. Control Deck does not load VST2 plugins; use the VST3 or AU version.`);
    if (input.expectedPath && normalizePath(resolved.path) !== normalizePath(input.expectedPath)) throw new Error(`Plugin path safeguard failed: expected '${input.expectedPath}', resolved '${resolved.path}'.`);
    const bridgeRequest = { trackKind: kind, trackIndex: input.trackIndex, expectedTrackName: trackName, name: resolved.name, format: resolved.format, path: resolved.path };
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = { ok: true, dryRun: true, tool: "load_plugin", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved }, intendedOperations: [{ address: "bridge://plugins.load", args: [JSON.stringify(bridgeRequest)] }] };
      await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }

    const before = await this.getDevices(kind, input.trackIndex);
    const selectedTrackBefore = await this.getSelectedTrackIndex();
    let acknowledgement: Record<string, unknown> | undefined;
    let acknowledgementError: string | undefined;
    try {
      acknowledgement = await this.bridge.loadPlugin(bridgeRequest);
    } catch (error) {
      acknowledgementError = error instanceof Error ? error.message : String(error);
    }

    const after = await this.waitForDeviceCount(kind, input.trackIndex, before.length + 1);
    const selectionRestored = await this.restoreSelectedTrack(selectedTrackBefore, kind === "track" ? input.trackIndex : undefined);
    if (!after) {
      const message = acknowledgementError ?? `Live did not confirm a new device after the bridge response.`;
      await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: acknowledgement, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "load_plugin", data: { completedActions: acknowledgement ? ["Bridge load request acknowledged"] : [], incompleteActions: ["Bridge device-chain verification", ...(!selectionRestored ? ["Selected-track restoration"] : [])], acknowledgement, selectionRestored }, error: { code: "PLUGIN_LOAD_NOT_VERIFIED", message } };
    }
    const newDevices = after.slice(before.length);
    const result: ToolResult = { ok: true, dryRun: false, tool: "load_plugin", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved, acknowledgement, acknowledgementReceived: Boolean(acknowledgement), acknowledgementError, newDevices, deviceCountBefore: before.length, deviceCountAfter: after.length, selectedTrackBefore, selectionRestored, warnings: selectionRestored ? [] : ["Plugin loaded, but the prior selected track could not be restored."] } };
    await this.logger.write({ tool: "load_plugin", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true });
    return result;
  }

  async findLiveDevice(name: string, path?: string): Promise<ToolResult> {
    return this.read("find_live_device", async () => this.bridge.resolveBrowserDevice(name, path));
  }

  async loadLiveDevice(input: { trackKind?: TrackKind; trackIndex: number; expectedTrackName: string; name: string; path?: string; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.trackIndex) || input.trackIndex < 0) throw new Error("Track index must be a non-negative integer.");
    const kind = input.trackKind ?? "track";
    const trackName = await this.requireTrackName(kind, input.trackIndex, input.expectedTrackName);
    const resolved = (await this.bridge.resolveBrowserDevice(input.name, input.path)).device;
    const bridgeRequest = { trackKind: kind, trackIndex: input.trackIndex, expectedTrackName: trackName, name: resolved.name, path: resolved.path };
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = { ok: true, dryRun: true, tool: "load_live_device", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved }, intendedOperations: [{ address: "bridge://devices.load_browser_item", args: [JSON.stringify(bridgeRequest)] }] };
      await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }

    const before = await this.getDevices(kind, input.trackIndex);
    const selectedTrackBefore = await this.getSelectedTrackIndex();
    let acknowledgement: Record<string, unknown> | undefined;
    let acknowledgementError: string | undefined;
    try {
      acknowledgement = await this.bridge.loadBrowserDevice(bridgeRequest);
    } catch (error) {
      acknowledgementError = error instanceof Error ? error.message : String(error);
    }

    const after = await this.waitForDeviceCount(kind, input.trackIndex, before.length + 1);
    const selectionRestored = await this.restoreSelectedTrack(selectedTrackBefore, kind === "track" ? input.trackIndex : undefined);
    if (!after) {
      const message = acknowledgementError ?? `Live did not confirm a new device after the bridge response.`;
      await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: acknowledgement, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "load_live_device", data: { completedActions: acknowledgement ? ["Bridge load request acknowledged"] : [], incompleteActions: ["Bridge device-chain verification", ...(!selectionRestored ? ["Selected-track restoration"] : [])], acknowledgement, selectionRestored }, error: { code: "DEVICE_LOAD_NOT_VERIFIED", message } };
    }
    const newDevices = after.slice(before.length);
    const result: ToolResult = { ok: true, dryRun: false, tool: "load_live_device", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved, acknowledgement, acknowledgementReceived: Boolean(acknowledgement), acknowledgementError, newDevices, deviceCountBefore: before.length, deviceCountAfter: after.length, selectedTrackBefore, selectionRestored, warnings: selectionRestored ? [] : ["Device loaded, but the prior selected track could not be restored."] } };
    await this.logger.write({ tool: "load_live_device", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true });
    return result;
  }

  async loadUserLibraryItem(input: { trackKind?: TrackKind; trackIndex: number; expectedTrackName: string; name: string; path?: string; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.trackIndex) || input.trackIndex < 0) throw new Error("Track index must be a non-negative integer.");
    if (!input.name.trim()) throw new Error("User Library item name must not be empty.");
    assertBrowserPath(input.path);
    const kind = input.trackKind ?? "track";
    const trackName = await this.requireTrackName(kind, input.trackIndex, input.expectedTrackName);
    let resolved: { name: string; path: string; kind: string };
    try {
      resolved = (await this.bridge.resolveUserLibraryItem(input.name, input.path)).item;
    } catch (error) {
      return this.bridgeFailure("load_user_library_item", started, error);
    }
    const bridgeRequest = { trackKind: kind, trackIndex: input.trackIndex, expectedTrackName: trackName, name: resolved.name, path: resolved.path };
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = { ok: true, dryRun: true, tool: "load_user_library_item", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved }, intendedOperations: [{ address: "bridge://devices.load_user_item", args: [JSON.stringify(bridgeRequest)] }] };
      await this.logger.write({ tool: "load_user_library_item", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }

    const before = await this.getDevices(kind, input.trackIndex);
    const selectedTrackBefore = await this.getSelectedTrackIndex();
    let acknowledgement: Record<string, unknown> | undefined;
    let acknowledgementError: string | undefined;
    try {
      acknowledgement = await this.bridge.loadUserDevice(bridgeRequest);
    } catch (error) {
      acknowledgementError = error instanceof Error ? error.message : String(error);
    }
    const after = await this.waitForDeviceChain(kind, input.trackIndex, before);
    const selectionRestored = await this.restoreSelectedTrack(selectedTrackBefore, kind === "track" ? input.trackIndex : undefined);
    const changed = deviceChainChanged(before, after);
    if (!changed) {
      const message = acknowledgementError ?? "Live acknowledged the load, but the device chain is unchanged. Save a Pigments or Serum 2 patch inside an Instrument Rack (.adg) so the rack appears as a new device.";
      await this.logger.write({ tool: "load_user_library_item", args: input, bridgeRequest, response: acknowledgement, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "load_user_library_item", data: { devicesBefore: before, devicesAfter: after, acknowledgement, selectionRestored }, error: { code: "USER_LIBRARY_LOAD_NOT_VERIFIED", message } };
    }
    const result: ToolResult = { ok: true, dryRun: false, tool: "load_user_library_item", data: { trackKind: kind, trackIndex: input.trackIndex, trackName, resolved, acknowledgement, acknowledgementReceived: Boolean(acknowledgement), acknowledgementError, devicesBefore: before, devicesAfter: after, deviceCountBefore: before.length, deviceCountAfter: after.length, selectedTrackBefore, selectionRestored, warnings: selectionRestored ? [] : ["Item loaded, but the prior selected track could not be restored."] } };
    await this.logger.write({ tool: "load_user_library_item", args: input, bridgeRequest, response: result.data, durationMs: performance.now() - started, success: true });
    return result;
  }

  private async resolve(name: string, format: PluginFormat, expectedPath?: string): Promise<ResolvedPlugin> {
    return (await this.bridge.resolvePlugin(name, format, expectedPath)).plugin;
  }

  /** The track's current name, which must match what the caller expects. */
  private async requireTrackName(kind: TrackKind, trackIndex: number, expected: string): Promise<string> {
    const { trackName } = await this.trackState(kind, trackIndex);
    if (trackName !== expected) throw new Error(`Track safeguard failed: expected '${expected}', found '${trackName}'.`);
    return trackName;
  }

  /** A regular track, a return track, or the master: its name and top-level devices. */
  private async trackState(kind: TrackKind, trackIndex: number): Promise<{ trackName: string; devices: Array<{ index: number; name: string; className: string }> }> {
    const args = (await this.live.query("/live/devices/get/state", [kind, oscInt(trackIndex)])).args;
    const count = Number(args[3]);
    if (!Number.isInteger(count) || args.length !== 4 + count * 3) throw new Error("Device state reply has the wrong length. Reinstall the Control Deck remote script and restart Live.");
    const devices = Array.from({ length: count }, (_, index) => ({ index, name: String(args[4 + index * 3]), className: String(args[5 + index * 3]) }));
    return { trackName: String(args[2]), devices };
  }

  private async getDevices(kind: TrackKind, trackIndex: number): Promise<Array<{ index: number; name: string; className: string }>> {
    return (await this.trackState(kind, trackIndex)).devices;
  }

  private async waitForDeviceChain(kind: TrackKind, trackIndex: number, before: Array<{ name: string; className: string }>): Promise<Array<{ index: number; name: string; className: string }>> {
    let latest = await this.getDevices(kind, trackIndex);
    for (let attempt = 0; attempt < 29 && !deviceChainChanged(before, latest); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      latest = await this.getDevices(kind, trackIndex);
    }
    return latest;
  }

  private async waitForDeviceCount(kind: TrackKind, trackIndex: number, expected: number): Promise<Array<{ index: number; name: string; className: string }> | null> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const devices = await this.getDevices(kind, trackIndex);
      if (devices.length >= expected) return devices;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  private async getSelectedTrackIndex(): Promise<number | undefined> {
    try { return Number((await this.live.query("/live/view/get/selected_track")).args.at(-1)); }
    catch { return undefined; }
  }

  private async restoreSelectedTrack(previous: number | undefined, target: number | undefined): Promise<boolean> {
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

  private async bridgeFailure(tool: string, started: number, error: unknown): Promise<ToolResult> {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "BRIDGE_ERROR";
    const details = (error as { details?: unknown })?.details;
    await this.logger.write({ tool, durationMs: performance.now() - started, success: false, error: message });
    return { ok: false, dryRun: false, tool, error: { code, message, ...(details !== undefined ? { details } : {}) } };
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

export function assertBrowserPath(path: string | undefined): void {
  if (path === undefined) return;
  const text = path.trim();
  if (!text) throw new Error("Browser path must not be empty.");
  if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:[\\/]/.test(text)) {
    throw new Error("path must be a Live Browser path such as 'User Library/Presets/Instruments/My Rack', not a file on disk. Save the patch as an Instrument Rack (.adg) or a device preset (.adv) in the User Library. Live's API cannot load a .vstpreset or .aupreset from a filesystem path.");
  }
}

function deviceChainChanged(before: Array<{ name: string; className: string }>, after: Array<{ name: string; className: string }>): boolean {
  if (before.length !== after.length) return true;
  return after.some((device, index) => device.name !== before[index]?.name || device.className !== before[index]?.className);
}
