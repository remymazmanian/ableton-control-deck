import { describe, expect, it, vi } from "vitest";
import { LiveTools } from "../src/live-tools.js";

const logger = { write: vi.fn() };

describe("transport and inspection", () => {
  it("constructs typed time-signature operations in dry-run mode", async () => {
    const fake = { send: vi.fn(), query: vi.fn() };
    const result = await new LiveTools(fake as never, logger as never).setTimeSignature(7, 8, true);
    expect(result).toMatchObject({ ok: true, dryRun: true, intendedOperations: [
      { address: "/live/song/set/signature_numerator", args: [{ type: "i", value: 7 }] },
      { address: "/live/song/set/signature_denominator", args: [{ type: "i", value: 8 }] }
    ] });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("starts playback and verifies state", async () => {
    const fake = { send: vi.fn(), query: vi.fn().mockResolvedValue({ args: [true] }) };
    const result = await new LiveTools(fake as never, logger as never).play();
    expect(fake.send).toHaveBeenCalledWith("/live/song/start_playing", []);
    expect(result).toMatchObject({ ok: true, data: { isPlaying: true } });
  });

  it("requires the expected device name before mutation", async () => {
    const fake = {
      send: vi.fn(),
      query: vi.fn(async (address: string) => {
        if (address.endsWith("track_names")) return { args: ["Synth"] };
        if (address.endsWith("/name")) return { args: [0, 0, "Operator"] };
        return { args: [0, 0, "InstrumentVector"] };
      })
    };
    const live = new LiveTools(fake as never, logger as never);
    await expect(live.setDeviceParameter(0, 0, 1, 0.5, "Serum")).rejects.toThrow(/safeguard/);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("lists only loaded third-party plugin devices", async () => {
    const fake = pluginClient();
    const result = await new LiveTools(fake as never, logger as never).listPluginDevices();
    expect(result).toMatchObject({ ok: true, data: { deviceCount: 1, tracks: [{ trackIndex: 0, trackName: "Audio", devices: [{ index: 0, name: "Pro-Q 4", className: "PluginDevice" }] }] } });
  });

  it("finds plugin parameters by human-readable name", async () => {
    const fake = pluginClient();
    const result = await new LiveTools(fake as never, logger as never).findPluginParameter(0, 0, "Pro-Q 4", "gain");
    expect(result).toMatchObject({ ok: true, data: { matched: 1, parameters: [{ index: 1, name: "Gain", value: 0.25, minimum: -12, maximum: 12 }] } });
  });

  it("sets a normalized plugin parameter and reads back its display value", async () => {
    const fake = pluginClient();
    const result = await new LiveTools(fake as never, logger as never).setPluginParameter({
      trackIndex: 0, deviceIndex: 0, expectedDeviceName: "Pro-Q 4", parameterName: "Gain", parameterIndex: 1, normalizedValue: 0.75
    });
    expect(fake.send).toHaveBeenCalledWith("/live/device/set/parameter/value", [
      { type: "i", value: 0 }, { type: "i", value: 0 }, { type: "i", value: 1 }, { type: "f", value: 6 }
    ]);
    expect(result).toMatchObject({ ok: true, data: { deviceName: "Pro-Q 4", parameterName: "Gain", previousValue: 0.25, requestedNormalizedValue: 0.75, value: 6, normalizedValue: 0.75, displayValue: "6 dB", quantized: false } });
  });
});

function pluginClient() {
  return {
    send: vi.fn(),
    query: vi.fn(async (address: string) => {
      const replies: Record<string, { args: unknown[] }> = {
        "/live/song/get/track_names": { args: ["Audio"] },
        "/live/track/get/devices/name": { args: [0, "Pro-Q 4", "EQ Eight"] },
        "/live/track/get/devices/type": { args: [0, 1, 1] },
        "/live/track/get/devices/class_name": { args: [0, "PluginDevice", "Eq8Device"] },
        "/live/device/get/name": { args: [0, 0, "Pro-Q 4"] },
        "/live/device/get/class_name": { args: [0, 0, "PluginDevice"] },
        "/live/device/get/parameters/name": { args: [0, 0, "Device On", "Gain"] },
        "/live/device/get/parameters/value": { args: [0, 0, 1, 0.25] },
        "/live/device/get/parameters/min": { args: [0, 0, 0, -12] },
        "/live/device/get/parameters/max": { args: [0, 0, 1, 12] },
        "/live/device/get/parameters/value_string": { args: [0, 0, "On", "-6 dB"] },
        "/live/device/get/parameter/value": { args: [0, 0, 1, 6] },
        "/live/device/get/parameter/value_string": { args: [0, 0, 1, "6 dB"] }
      };
      const reply = replies[address];
      if (!reply) throw new Error(`Unexpected query ${address}`);
      return reply;
    })
  };
}
