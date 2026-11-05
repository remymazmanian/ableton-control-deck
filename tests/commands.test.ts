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
  it("splits a long Session note write and reports a partial landing", async () => {
    const notes = Array.from({ length: 400 }, (_, index) => ({ pitch: 60, startTime: index * 0.25, duration: 0.25, velocity: 100 }));
    const fake = {
      send: vi.fn(async (_address: string, args: unknown[]) => {
        if (fake.send.mock.calls.length > 1) throw new Error("send EMSGSIZE");
        void args;
      }),
      query: vi.fn().mockResolvedValue({ address: "/live/clip/get/notes", args: [] })
    };
    const failed = await new AbletonCommands(fake as never, { write: vi.fn() } as never).addMidiNotes(0, 0, notes);
    expect(failed.ok).toBe(false);
    expect(failed.error?.message).toMatch(/notes landed/);
    expect(failed.error?.details).toMatchObject({ phase: "send", notesRequested: 400, chunksCompleted: 1 });
    expect((failed.error?.details as { notesLanded: number }).notesLanded).toBeGreaterThan(0);
    expect((failed.error?.details as { notesLanded: number }).notesLanded).toBeLessThan(400);

    const okFake = { send: vi.fn(), query: vi.fn().mockResolvedValue({ address: "/live/clip/get/notes", args: [0, 0] }) };
    const result = await new AbletonCommands(okFake as never, { write: vi.fn() } as never).addMidiNotes(0, 0, notes);
    expect(result.ok).toBe(true);
    expect(okFake.send.mock.calls.length).toBeGreaterThan(1);
    const pitches = okFake.send.mock.calls.flatMap(call => (call[1] as Array<{ value?: number } | boolean>).filter((_value, index) => index >= 2 && (index - 2) % 5 === 0).map(value => (value as { value: number }).value));
    expect(pitches).toEqual(notes.map(() => 60));
    expect(okFake.query).toHaveBeenCalledTimes(1);
  });

  it("returns structured failures", async () => {
    const fake = { send: vi.fn().mockRejectedValue(new Error("offline")), query: vi.fn().mockResolvedValue({ args: [] }) };
    const result = await new AbletonCommands(fake as never, { write: vi.fn() } as never).createMidiTrack(-1);
    expect(result).toMatchObject({ ok: false, error: { code: "ABLETON_OPERATION_FAILED", message: "offline" } });
  });
});
