import { describe, expect, it, vi } from "vitest";
import { AbletonCommands } from "../src/commands.js";

const fake = { send: vi.fn(), query: vi.fn(), close: vi.fn() };
const logger = { write: vi.fn() };

describe("safety and dry run", () => {
  it("requires confirmation before deleting", async () => {
    const commands = new AbletonCommands(fake as never, logger as never);
    await expect(commands.deleteTrack(0, false)).rejects.toThrow(/confirm=true/);
  });
  it("dry-runs without sending a Live command", async () => {
    fake.send.mockClear();
    const result = await new AbletonCommands(fake as never, logger as never).createMidiTrack(-1, true);
    expect(result).toMatchObject({ ok: true, dryRun: true, intendedOperations: [{ address: "/live/song/create_midi_track", args: [{ type: "i", value: -1 }] }] });
    expect(fake.send).not.toHaveBeenCalled();
  });
});
