import { describe, expect, it, vi } from "vitest";
import { LiveTools } from "../src/live-tools.js";
import { parseNoteReply } from "../src/notes.js";

const logger = { write: vi.fn() };

function noteClient(notesArgs: unknown[], lengths: unknown[] = [0, 4, null]) {
  return {
    send: vi.fn(),
    query: vi.fn(async (address: string) => {
      if (address === "/live/clip/get/notes") return { address, args: notesArgs };
      if (address === "/live/track/get/clips/length") return { address, args: lengths };
      throw new Error(`unexpected query ${address}`);
    })
  };
}

describe("get_clip_notes", () => {
  it("returns sorted notes and the clip length without sending anything", async () => {
    const fake = noteClient([0, 0, 64, 1, 0.5, 90, false, 60, 0, 1, 100, false, 55, 0, 1, 80, true]);
    const result = await new LiveTools(fake as never, logger as never).getClipNotes(0, 0);
    expect(result).toMatchObject({ ok: true, data: { trackIndex: 0, sceneIndex: 0, lengthBeats: 4, noteCount: 3 } });
    expect((result.data as { notes: unknown[] }).notes).toEqual([
      { pitch: 55, startTime: 0, duration: 1, velocity: 80, mute: true },
      { pitch: 60, startTime: 0, duration: 1, velocity: 100, mute: false },
      { pitch: 64, startTime: 1, duration: 0.5, velocity: 90, mute: false }
    ]);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("returns an empty list for a clip with no notes", async () => {
    const result = await new LiveTools(noteClient([0, 0]) as never, logger as never).getClipNotes(0, 0);
    expect(result).toMatchObject({ ok: true, data: { noteCount: 0, notes: [] } });
  });

  it("fails loudly when the reply is truncated", async () => {
    const result = await new LiveTools(noteClient([0, 0, 60, 0, 1, 100]) as never, logger as never).getClipNotes(0, 0);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/multiple of 5/) } });
  });

  it("fails loudly when the reply addresses a different clip", async () => {
    const result = await new LiveTools(noteClient([0, 1, 60, 0, 1, 100, false]) as never, logger as never).getClipNotes(0, 0);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/expected 0:0/) } });
  });

  it("fails when the slot has no clip length", async () => {
    const result = await new LiveTools(noteClient([0, 2]) as never, logger as never).getClipNotes(0, 2);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No clip exists/) } });
  });

  it("surfaces bridge errors as structured failures", async () => {
    const fake = { send: vi.fn(), query: vi.fn().mockRejectedValue(new Error("CLIP_NOT_FOUND")) };
    const result = await new LiveTools(fake as never, logger as never).getClipNotes(0, 0);
    expect(result).toMatchObject({ ok: false, tool: "get_clip_notes", error: { code: "ABLETON_OPERATION_FAILED", message: "CLIP_NOT_FOUND" } });
  });

  it("rejects non-numeric note values", () => {
    expect(() => parseNoteReply([0, 0, "x", 0, 1, 100, false], 0, 0)).toThrow(/Malformed/);
  });
});
