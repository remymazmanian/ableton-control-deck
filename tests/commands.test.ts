import { describe, expect, it, vi } from "vitest";
import { AbletonCommands } from "../src/commands.js";

describe("Live-control construction and errors", () => {
  it("constructs the Control Deck note operation", async () => {
    const fake = { send: vi.fn(), query: vi.fn().mockResolvedValue({ address: "/live/clip/get/notes", args: [0, 0, 60, 0, 1, 100, false] }) };
    const result = await new AbletonCommands(fake as never, { write: vi.fn() } as never).addMidiNotes(0, 0, [{ pitch: "C3", startTime: 0, duration: 1, velocity: 100 }]);
    expect(fake.send).toHaveBeenCalledWith("/live/clip/add/notes", [
      { type: "i", value: 0 }, { type: "i", value: 0 }, { type: "i", value: 60 },
      { type: "f", value: 0 }, { type: "f", value: 1 }, { type: "i", value: 100 }, false
    ]);
    expect(result.ok).toBe(true);
  });
  it("returns structured failures", async () => {
    const fake = { send: vi.fn().mockRejectedValue(new Error("offline")), query: vi.fn().mockResolvedValue({ args: [] }) };
    const result = await new AbletonCommands(fake as never, { write: vi.fn() } as never).createMidiTrack(-1);
    expect(result).toMatchObject({ ok: false, error: { code: "ABLETON_OPERATION_FAILED", message: "offline" } });
  });
});
