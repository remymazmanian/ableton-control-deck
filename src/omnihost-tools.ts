import { JsonLogger } from "./logger.js";
import type { OmnihostControlClient } from "./omnihost-client.js";
import type { AbletonClient } from "./ableton-client.js";
import type { ToolResult } from "./types.js";

export class OmnihostTools {
  constructor(private readonly client: OmnihostControlClient, private readonly bridge?: AbletonClient, private readonly logger = new JsonLogger(), private readonly defaultDryRun = false) {}

  status(): Promise<ToolResult> { return this.read("omnihost_status", () => this.client.status()); }

  listParameters(input: { query?: string; includeHelpers?: boolean; limit?: number; offset?: number }): Promise<ToolResult> {
    return this.read("list_omnihost_parameters", () => this.client.listParameters(input));
  }

  getParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string }): Promise<ToolResult> {
    return this.read("get_omnihost_parameter", () => this.client.getParameter(input));
  }

  async setParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string; normalizedValue: number; dryRun?: boolean }): Promise<ToolResult> {
    const started = performance.now();
    if (!Number.isInteger(input.parameterIndex) || input.parameterIndex < 1) throw new Error("OmniHost parameter index must be a positive integer.");
    if (!Number.isFinite(input.normalizedValue) || input.normalizedValue < 0 || input.normalizedValue > 1) throw new Error("normalizedValue must be between 0 and 1.");
    const identity = await this.client.getParameter({ expectedPluginName: input.expectedPluginName, parameterIndex: input.parameterIndex, expectedParameterName: input.expectedParameterName });
    if (input.dryRun || this.defaultDryRun) {
      const result: ToolResult = {
        ok: true, dryRun: true, tool: "set_omnihost_parameter",
        data: { pluginName: identity.pluginName, index: identity.index, name: identity.name, currentNormalizedValue: identity.normalizedValue, requestedNormalizedValue: input.normalizedValue },
        intendedOperations: [{ address: "omnihost://parameter/set", args: [input.parameterIndex, input.expectedParameterName, input.normalizedValue] }]
      };
      await this.logger.write({ tool: "set_omnihost_parameter", args: input, response: result.data, durationMs: performance.now() - started, success: true, dryRun: true });
      return result;
    }
    try {
      const data = await this.client.setParameter({ expectedPluginName: input.expectedPluginName, parameterIndex: input.parameterIndex, expectedParameterName: input.expectedParameterName, normalizedValue: input.normalizedValue });
      const result: ToolResult = { ok: true, dryRun: false, tool: "set_omnihost_parameter", data };
      await this.logger.write({ tool: "set_omnihost_parameter", args: input, response: data, durationMs: performance.now() - started, success: true });
      return result;
    } catch (error) {
      return this.failure("set_omnihost_parameter", started, error);
    }
  }

  openEditor(): Promise<ToolResult> { return this.read("open_omnihost_plugin", () => this.client.openEditor()); }
  refreshCatalog(): Promise<ToolResult> { return this.read("refresh_omnihost_parameters", () => this.client.refreshCatalog()); }

  async loadOnTrack(input: { trackIndex: number; expectedTrackName: string; dryRun?: boolean }): Promise<ToolResult> {
    if (!this.bridge) return { ok: false, dryRun: false, tool: "load_omnihost_on_track", error: { code: "BRIDGE_ERROR", message: "Control Deck Bridge is unavailable." } };
    if (input.dryRun || this.defaultDryRun) {
      return {
        ok: true, dryRun: true, tool: "load_omnihost_on_track",
        data: { name: "Control Deck OmniHost", trackIndex: input.trackIndex, expectedTrackName: input.expectedTrackName },
        intendedOperations: [{ address: "bridge://devices.load_user_item", args: [input.trackIndex, input.expectedTrackName, "Control Deck OmniHost"] }]
      };
    }
    return this.read("load_omnihost_on_track", () => this.bridge!.loadUserDevice({ trackIndex: input.trackIndex, expectedTrackName: input.expectedTrackName, name: "Control Deck OmniHost" }));
  }

  private async read<T>(tool: string, operation: () => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    try {
      const data = await operation();
      await this.logger.write({ tool, response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool, data };
    } catch (error) {
      return this.failure(tool, started, error) as Promise<ToolResult<T>>;
    }
  }

  private async failure(tool: string, started: number, error: unknown): Promise<ToolResult> {
    const message = error instanceof Error ? error.message : String(error);
    await this.logger.write({ tool, durationMs: performance.now() - started, success: false, error: message });
    return { ok: false, dryRun: false, tool, error: { code: "CONTROL_DECK_OMNIHOST_ERROR", message } };
  }
}
