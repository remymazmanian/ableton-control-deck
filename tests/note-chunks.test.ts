import { describe, expect, it } from "vitest";
import { AbletonClient, asBridgeSendError, liveCommandDatagramBytes, requestTooLargeError, MAX_UDP_REQUEST_BYTES } from "../src/ableton-client.js";
import {
  ARRANGEMENT_ADD_NOTES_PER_DATAGRAM,
  BRIDGE_NOTES_PER_DATAGRAM,
  chunkBySerializedBytes,
  DatagramBudgetError,
  measureCommandBytes,
  NOTE_DATAGRAM_BUDGET_BYTES,
  NoteBatchPartialError,
  sendChunksSequentially
} from "../src/note-chunks.js";

const bytesFor = (slice: readonly { weight: number }[]) => 20 + slice.reduce((sum, item) => sum + item.weight, 0);

describe("note datagram chunker", () => {
  it("keeps every chunk inside the byte budget and packs each one", () => {
    const items = [10, 30, 25, 40, 15, 50, 5].map(weight => ({ weight }));
    const maxBytes = 80;
    const chunks = chunkBySerializedBytes(items, { maxBytes, maxPerChunk: 10, serializedBytes: bytesFor });
    expect(chunks.flat()).toEqual(items);
    for (const [index, chunk] of chunks.entries()) {
      expect(bytesFor(chunk)).toBeLessThanOrEqual(maxBytes);
      const next = items[chunks.slice(0, index + 1).reduce((sum, part) => sum + part.length, 0)];
      if (next && chunk.length < 10) expect(bytesFor([...chunk, next])).toBeGreaterThan(maxBytes);
    }
    expect(chunks.map(chunk => chunk.map(item => item.weight))).toEqual([[10, 30], [25], [40, 15], [50, 5]]);
  });

  it("preserves order when the per-datagram note cap binds before the byte budget", () => {
    const notes = Array.from({ length: 1000 }, (_, index) => index);
    const chunks = chunkBySerializedBytes(notes, {
      maxBytes: 1_000_000,
      maxPerChunk: BRIDGE_NOTES_PER_DATAGRAM,
      serializedBytes: slice => slice.length
    });
    expect(chunks.length).toBe(4);
    expect(chunks.map(chunk => chunk.length)).toEqual([256, 256, 256, 232]);
    expect(chunks.flat()).toEqual(notes);
  });

  it("splits 1000 arrangement-sized notes under 7 KB and 256 notes", () => {
    const notes = Array.from({ length: 1000 }, (_, index) => ({
      pitch: 60 + (index % 12),
      startTime: index * 0.25,
      duration: 0.25,
      velocity: 80 + (index % 40),
      mute: index % 17 === 0
    }));
    const serializedBytes = (slice: readonly typeof notes[number][]) => {
      const args: unknown[] = [0, "Bass", 0, 0];
      for (const note of slice) args.push(note.pitch, note.startTime, note.duration, note.velocity, note.mute);
      return liveCommandDatagramBytes("0".repeat(36), "/live/arrangement_clip/add/notes", args);
    };
    const chunks = chunkBySerializedBytes(notes, {
      maxBytes: NOTE_DATAGRAM_BUDGET_BYTES,
      maxPerChunk: ARRANGEMENT_ADD_NOTES_PER_DATAGRAM,
      serializedBytes
    });
    expect(notes.length).toBeGreaterThan(1000 - 1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(notes);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(BRIDGE_NOTES_PER_DATAGRAM);
      expect(chunk.length).toBeGreaterThan(0);
      expect(serializedBytes(chunk)).toBeLessThanOrEqual(NOTE_DATAGRAM_BUDGET_BYTES);
    }
    expect(chunks[0].length).toBe(BRIDGE_NOTES_PER_DATAGRAM);
  });

  it("refuses a single note that cannot fit in one datagram", () => {
    expect(() => chunkBySerializedBytes([{ weight: 500 }], { maxBytes: 40, maxPerChunk: 10, serializedBytes: bytesFor })).toThrow(DatagramBudgetError);
    expect(() => chunkBySerializedBytes([{ weight: 500 }], { maxBytes: 40, maxPerChunk: 10, serializedBytes: bytesFor })).toThrow(/Request too large/);
  });

  it("reports how many notes landed when a later batch fails", async () => {
    const chunks = [[1, 2, 3], [4, 5], [6]];
    const landed: number[] = [];
    await expect(sendChunksSequentially(chunks, async (chunk, index) => {
      if (index === 2) throw new Error("send EMSGSIZE");
      landed.push(...chunk);
    })).rejects.toMatchObject({
      name: "NoteBatchPartialError",
      notesLanded: 5,
      notesRequested: 6,
      chunksCompleted: 2,
      chunksPlanned: 3,
      phase: "send"
    });
    expect(landed).toEqual([1, 2, 3, 4, 5]);
    try {
      await sendChunksSequentially(chunks, async (_chunk, index) => {
        if (index === 2) throw new Error("send EMSGSIZE");
      });
    } catch (error) {
      expect(error).toBeInstanceOf(NoteBatchPartialError);
      expect((error as Error).message).toMatch(/5 of 6 notes landed/);
      expect((error as Error).message).toMatch(/2 of 3 batches/);
      expect((error as Error).message).toMatch(/EMSGSIZE/);
    }
  });
});

describe("UDP request size guard", () => {
  it("names a request-too-large error instead of a raw EMSGSIZE", () => {
    const guarded = requestTooLargeError(9000);
    expect(guarded.code).toBe("REQUEST_TOO_LARGE");
    expect(guarded.message).toMatch(/Request too large: 9000 bytes/);
    const fromOs = asBridgeSendError(Object.assign(new Error("send EMSGSIZE"), { code: "EMSGSIZE" }), 9500);
    expect(fromOs).toMatchObject({ code: "REQUEST_TOO_LARGE", message: expect.stringMatching(/Request too large: 9500 bytes/) });
    expect((fromOs as Error).message).toMatch(/EMSGSIZE/);
    const other = Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
    expect(asBridgeSendError(other, 10)).toBe(other);
  });

  it("rejects an oversized datagram before sending it", async () => {
    const client = new AbletonClient({ token: "test-token", port: 9, timeoutMs: 200 });
    try {
      const args = Array.from({ length: 3000 }, (_, index) => index);
      await expect(client.request("live.command", { address: "/live/clip/add/notes", args })).rejects.toMatchObject({
        code: "REQUEST_TOO_LARGE",
        message: expect.stringMatching(/Request too large/)
      });
      const measured = liveCommandDatagramBytes("test-token", "/live/clip/add/notes", [60, 0, 1, 100, false]);
      expect(measured).toBeLessThan(MAX_UDP_REQUEST_BYTES);
      expect(client.commandBytes("/live/clip/add/notes", [60, 0, 1, 100, false])).toBe(
        measureCommandBytes(client, "/live/clip/add/notes", [60, 0, 1, 100, false])
      );
    } finally {
      client.close();
    }
  });
});
