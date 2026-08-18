import { describe, expect, it, vi } from "vitest";
import type { OmnihostControlClient } from "../src/omnihost-client.js";
import { OmnihostTools } from "../src/omnihost-tools.js";

describe("OmnihostTools", () => {
  it("validates identity before returning a dry run", async () => {
    const client = fakeClient();
    const tools = new OmnihostTools(client, undefined, { write: vi.fn() } as never);
    const result = await tools.setParameter({ expectedPluginName: "Mini V4", parameterIndex: 29, expectedParameterName: "Filter Cutoff", normalizedValue: 0.75, dryRun: true });
    expect(client.getParameter).toHaveBeenCalledWith({ expectedPluginName: "Mini V4", parameterIndex: 29, expectedParameterName: "Filter Cutoff" });
    expect(client.setParameter).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, dryRun: true, data: { requestedNormalizedValue: 0.75 } });
  });

  it("sets a normalized value with read-back data", async () => {
    const client = fakeClient();
    const tools = new OmnihostTools(client, undefined, { write: vi.fn() } as never);
    const result = await tools.setParameter({ expectedPluginName: "Mini V4", parameterIndex: 29, expectedParameterName: "Filter Cutoff", normalizedValue: 0.4 });
    expect(result).toMatchObject({ ok: true, dryRun: false, data: { name: "Filter Cutoff", requestedNormalizedValue: 0.4, normalizedValue: 0.4 } });
  });
});

function fakeClient(): OmnihostControlClient & { getParameter: ReturnType<typeof vi.fn>; setParameter: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(), listParameters: vi.fn(), openEditor: vi.fn(), refreshCatalog: vi.fn(),
    getParameter: vi.fn().mockResolvedValue({ pluginName: "Mini V4", index: 29, name: "Filter Cutoff", helper: false, normalizedValue: 0.5, displayValue: "500 Hz" }),
    setParameter: vi.fn().mockResolvedValue({ pluginName: "Mini V4", index: 29, name: "Filter Cutoff", helper: false, previousNormalizedValue: 0.5, previousDisplayValue: "500 Hz", requestedNormalizedValue: 0.4, normalizedValue: 0.4, displayValue: "320 Hz" })
  };
}
