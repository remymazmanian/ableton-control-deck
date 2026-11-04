import { describe, expect, it, vi } from "vitest";
import { LiveTools } from "../src/live-tools.js";

const logger = { write: vi.fn() };

function colorClient() {
  const state = { name: "Bass", color: 0xff7700, colorIndex: 60, snapRgb: false };
  const plain = (args: unknown[]) => args.map(value => value !== null && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value);
  const live = {
    state,
    send: vi.fn(async (address: string, args: unknown[] = []) => {
      const value = plain(args);
      if (address !== "/live/track/set/color") return;
      if (value[1] !== state.name) throw new Error(`Expected track '${String(value[1])}', found '${state.name}'.`);
      if (value[2] === "index") state.colorIndex = Number(value[3]);
      else if (value[2] === "rgb") {
        state.color = state.snapRgb ? 0xff5500 : Number(value[3]);
        if (state.snapRgb) state.colorIndex = 12;
      }
    }),
    query: vi.fn(async (address: string) => {
      if (address === "/live/song/get/track_names") return { args: [state.name] };
      if (address === "/live/track/get/color") return { args: [0, state.color, state.colorIndex] };
      return { args: [] };
    })
  };
  return live;
}

describe("track color tools", () => {
  it("reads the palette index and RGB", async () => {
    const result = await new LiveTools(colorClient() as never, logger as never).getTrackColor({ trackIndex: 0 });
    expect(result).toMatchObject({ ok: true, data: { trackIndex: 0, trackName: "Bass", color: 0xff7700, rgb: "#FF7700", colorIndex: 60 } });
  });

  it("sets a palette index and reads it back", async () => {
    const live = colorClient();
    const result = await new LiveTools(live as never, logger as never).setTrackColor({ trackIndex: 0, expectedTrackName: "Bass", colorIndex: 14 });
    expect(live.send).toHaveBeenCalledWith("/live/track/set/color", [
      { type: "i", value: 0 }, "Bass", "index", { type: "i", value: 14 }
    ]);
    expect(result).toMatchObject({ ok: true, data: { colorIndex: 14, requestedColorIndex: 14, snapped: false, trackName: "Bass" } });
  });

  it("reports the palette color Live kept when an RGB value is snapped", async () => {
    const live = colorClient();
    live.state.snapRgb = true;
    const result = await new LiveTools(live as never, logger as never).setTrackColor({ trackIndex: 0, expectedTrackName: "Bass", rgb: "#112233" });
    expect(result).toMatchObject({
      ok: true,
      data: { requestedRgb: "#112233", color: 0xff5500, rgb: "#FF5500", colorIndex: 12, snapped: true }
    });
  });

  it("refuses both forms, neither form, a palette index past 69, and the wrong track name", async () => {
    const live = colorClient();
    const tools = new LiveTools(live as never, logger as never);
    await expect(tools.setTrackColor({ trackIndex: 0, expectedTrackName: "Bass", colorIndex: 1, rgb: "#112233" })).rejects.toThrow(/not both/);
    await expect(tools.setTrackColor({ trackIndex: 0, expectedTrackName: "Bass" })).rejects.toThrow(/colorIndex or rgb/);
    await expect(tools.setTrackColor({ trackIndex: 0, expectedTrackName: "Bass", colorIndex: 70 })).rejects.toThrow(/0 to 69/);
    await expect(tools.setTrackColor({ trackIndex: 0, expectedTrackName: "Drums", colorIndex: 1 })).rejects.toThrow(/safeguard/);
    expect(live.send).not.toHaveBeenCalled();
    expect(live.state.color).toBe(0xff7700);
  });

  it("dry-runs without writing", async () => {
    const live = colorClient();
    const result = await new LiveTools(live as never, logger as never).setTrackColor({ trackIndex: 0, expectedTrackName: "Bass", rgb: "#112233", dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, intendedOperations: [{ address: "/live/track/set/color", args: [{ type: "i", value: 0 }, "Bass", "rgb", { type: "i", value: 0x112233 }] }] });
    expect(live.send).not.toHaveBeenCalled();
  });
});