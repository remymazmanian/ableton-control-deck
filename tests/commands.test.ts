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

describe("add_midi_notes read-back verification", () => {
  const request = [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }, { pitch: 64, startTime: 1, duration: 0.5, velocity: 90 }];
  const run = (args: unknown[]) => {
    const fake = { send: vi.fn(), query: vi.fn().mockResolvedValue({ address: "/live/clip/get/notes", args }) };
    return new AbletonCommands(fake as never, { write: vi.fn() } as never).addMidiNotes(0, 0, request);
  };

  it("passes when every requested note is read back, alongside notes already in the clip", async () => {
    const result = await run([0, 0, 48, 2, 1, 70, false, 64, 1, 0.5, 90, false, 60, 0.0004, 1, 100.0, false]);
    expect(result).toMatchObject({ ok: true, data: { noteCountRequested: 2, noteCountVerified: 2, noteCountInClip: 3 } });
  });

  it.each([
    ["a dropped note", [0, 0, 60, 0, 1, 100, false]],
    ["a wrong pitch", [0, 0, 61, 0, 1, 100, false, 64, 1, 0.5, 90, false]],
    ["a shifted start", [0, 0, 60, 0.01, 1, 100, false, 64, 1, 0.5, 90, false]],
    ["a wrong duration", [0, 0, 60, 0, 1, 100, false, 64, 1, 0.25, 90, false]],
    ["a wrong velocity", [0, 0, 60, 0, 1, 100, false, 64, 1, 0.5, 89, false]],
    ["an unexpected mute", [0, 0, 60, 0, 1, 100, false, 64, 1, 0.5, 90, true]],
    ["one clip note standing in for two requests", [0, 0, 60, 0, 1, 100, false]],
    ["a reply for another clip", [0, 1, 60, 0, 1, 100, false, 64, 1, 0.5, 90, false]]
  ])("fails loudly on %s", async (_label, args) => {
    const result = await run(args);
    expect(result).toMatchObject({ ok: false, tool: "add_midi_notes", error: { code: "ABLETON_OPERATION_FAILED" } });
    expect(result.error?.message).toMatch(/verification failed|expected 0:0/);
  });

  it("names the missing note in the error", async () => {
    const result = await run([0, 0, 60, 0, 1, 100, false]);
    expect(result.error?.message).toMatch(/1 of 2 requested notes.*pitch 64 at 1/);
  });
});
