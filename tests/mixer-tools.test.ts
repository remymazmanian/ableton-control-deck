import { describe, expect, it, vi } from "vitest";
import { LiveTools } from "../src/live-tools.js";

const logger = { write: vi.fn() };

function mixerClient() {
  const state = {
    name: "Bass",
    volume: 0.85,
    volumeDisplay: "0.00 dB",
    pan: 0,
    panDisplay: "C",
    mute: false,
    solo: false,
    sends: [
      { name: "A-Return", returnName: "Delay", level: 0, display: "-inf dB" },
      { name: "B-Return", returnName: "Reverb", level: 1, display: "0.00 dB" }
    ],
    master: 0.85,
    masterDisplay: "0.00 dB"
  };
  const plain = (args: unknown[]) => args.map(value => value !== null && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value);
  const mixerArgs = () => [
    0, state.volume, state.volumeDisplay, state.pan, state.panDisplay, state.mute, state.solo,
    ...state.sends.flatMap((send, index) => [index, send.name, send.returnName, send.level, 0, 1, send.display])
  ];
  const live = {
    state,
    send: vi.fn(async (address: string, args: unknown[] = []) => {
      const value = plain(args);
      if (String(value[1] ?? "") !== state.name && address.startsWith("/live/track/")) throw new Error(`Expected track '${value[1]}', found '${state.name}'.`);
      if (address === "/live/track/set/volume") {
        state.volume = Number(value[2]);
        state.volumeDisplay = `${state.volume.toFixed(2)} norm`;
      } else if (address === "/live/track/set/panning") {
        state.pan = Number(value[2]);
        state.panDisplay = state.pan === 0 ? "C" : `${Math.abs(state.pan) * 50}${state.pan < 0 ? "L" : "R"}`;
      } else if (address === "/live/track/set/send") {
        const send = state.sends[Number(value[2])];
        if (!send || (value[3] !== send.name && value[3] !== send.returnName)) throw new Error("send mismatch");
        send.level = Number(value[4]);
        send.display = `${send.level.toFixed(2)} send`;
      } else if (address === "/live/track/set/mute") state.mute = Boolean(value[2]);
      else if (address === "/live/track/set/solo") state.solo = Boolean(value[2]);
      else if (address === "/live/song/set/master_volume") {
        state.master = Number(value[0]);
        state.masterDisplay = `${state.master.toFixed(2)} master`;
      }
    }),
    query: vi.fn(async (address: string) => {
      if (address === "/live/song/get/track_names") return { args: [state.name] };
      if (address === "/live/track/get/mixer") return { args: mixerArgs() };
      if (address === "/live/song/get/master_volume") return { args: [state.master, state.masterDisplay] };
      return { args: [] };
    })
  };
  return live;
}

describe("mixer tools", () => {
  it("reads master volume and a track's sends", async () => {
    const live = mixerClient();
    const result = await new LiveTools(live as never, logger as never).getMixer({ trackIndex: 0, expectedTrackName: "Bass" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        master: { volume: 0.85, displayValue: "0.00 dB", db: 0 },
        track: { name: "Bass", muted: false, sends: [{ index: 0, returnName: "Delay" }, { index: 1, name: "B-Return", level: 1 }] }
      }
    });
  });

  it("sets volume from dB, reads back Live's value and display string, and refuses an out-of-range request", async () => {
    const live = mixerClient();
    const tools = new LiveTools(live as never, logger as never);
    const result = await tools.setTrackVolume({ trackIndex: 0, expectedTrackName: "Bass", db: -6 });
    expect(live.send).toHaveBeenCalledWith("/live/track/set/volume", [
      { type: "i", value: 0 }, "Bass", { type: "f", value: 0.7 }
    ]);
    expect(result).toMatchObject({ ok: true, data: { requestedDb: -6, normalizedValue: 0.7, value: 0.7, displayValue: "0.70 norm", db: -6 } });
    await expect(tools.setTrackVolume({ trackIndex: 0, expectedTrackName: "Bass", db: 12 })).rejects.toThrow(/\+6 dB/);
    await expect(tools.setTrackVolume({ trackIndex: 0, expectedTrackName: "Drums", db: 0 })).rejects.toThrow(/safeguard/);
  });

  it("sets pan, a send by return name, mute, solo, and master volume", async () => {
    const live = mixerClient();
    const tools = new LiveTools(live as never, logger as never);
    const pan = await tools.setTrackPan({ trackIndex: 0, expectedTrackName: "Bass", pan: -1 });
    expect(pan).toMatchObject({ ok: true, data: { pan: -1, displayValue: "50L" } });
    const send = await tools.setTrackSend({ trackIndex: 0, expectedTrackName: "Bass", sendName: "Delay", level: 0.5 });
    expect(send).toMatchObject({ ok: true, data: { sendIndex: 0, sendName: "A-Return", returnName: "Delay", level: 0.5, displayValue: "0.50 send" } });
    expect(live.send).toHaveBeenCalledWith("/live/track/set/send", [
      { type: "i", value: 0 }, "Bass", { type: "i", value: 0 }, "A-Return", { type: "f", value: 0.5 }
    ]);
    expect(await tools.setTrackMute({ trackIndex: 0, expectedTrackName: "Bass", mute: true })).toMatchObject({ ok: true, data: { muted: true } });
    expect(await tools.setTrackSolo({ trackIndex: 0, expectedTrackName: "Bass", solo: true })).toMatchObject({ ok: true, data: { soloed: true } });
    const master = await tools.setMasterVolume({ db: 0 });
    expect(master).toMatchObject({ ok: true, data: { normalizedValue: 0.85, value: 0.85, displayValue: "0.85 master", db: 0 } });
    await expect(tools.setTrackPan({ trackIndex: 0, expectedTrackName: "Bass", pan: 2 })).rejects.toThrow(/Pan must be/);
    await expect(tools.setTrackSend({ trackIndex: 0, expectedTrackName: "Bass", sendIndex: 0, level: 1.2 })).rejects.toThrow(/Send level/);
    expect(live.state.sends[0].level).toBe(0.5);
  });

  it("dry-runs a volume change after the track name matches", async () => {
    const live = mixerClient();
    const result = await new LiveTools(live as never, logger as never).setTrackVolume({ trackIndex: 0, expectedTrackName: "Bass", db: -6, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, intendedOperations: [{ address: "/live/track/set/volume" }] });
    expect(live.send).not.toHaveBeenCalled();
    expect(live.state.volume).toBe(0.85);
  });

  it("fails when Live's read-back does not match the volume that was sent", async () => {
    const live = mixerClient();
    live.send.mockImplementation(async () => undefined);
    const result = await new LiveTools(live as never, logger as never).setTrackVolume({ trackIndex: 0, expectedTrackName: "Bass", db: -6 });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Volume verification failed/) } });
  });
});