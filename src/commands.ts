import { verifyAddedNotes } from "./arrangement-clips.js";
import { JsonLogger } from "./logger.js";
import { chunkOscNotes, DatagramBudgetError, MAX_NOTES_PER_CALL, noteBatchErrorBody, NoteBatchPartialError, readBackFailed, sendChunksSequentially, SESSION_ADD_NOTES_PER_DATAGRAM } from "./note-chunks.js";
import { sceneIndexSchema, tempoSchema, trackIndexSchema, validateNotes } from "./validation.js";
import { oscFloat, oscInt, type LiveControlClient, type MidiNote, type OscArgument, type ToolResult } from "./types.js";

export class AbletonCommands {
  constructor(private readonly live: LiveControlClient, private readonly logger = new JsonLogger(), private readonly defaultDryRun = false) {}

  private async run<T>(tool: string, args: unknown, op: { address: string; args?: OscArgument[] }, dryRun: boolean, verify?: () => Promise<T>): Promise<ToolResult<T>> {
    const started = performance.now();
    try {
      if (dryRun || this.defaultDryRun) {
        const result: ToolResult<T> = { ok: true, dryRun: true, tool, intendedOperations: [{ address: op.address, args: op.args ?? [] }] };
        await this.logger.write({ tool, args, liveOperation: op, durationMs: performance.now() - started, success: true, dryRun: true });
        return result;
      }
      await this.live.send(op.address, op.args ?? []);
      const data = verify ? await verify() : undefined;
      const result: ToolResult<T> = { ok: true, dryRun: false, tool, data };
      await this.logger.write({ tool, args, liveOperation: op, response: data, durationMs: performance.now() - started, success: true });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.write({ tool, args, liveOperation: op, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool, error: { code: "ABLETON_OPERATION_FAILED", message } };
    }
  }

  async status(): Promise<ToolResult> {
    const started = performance.now();
    try {
      const reply = await this.live.query("/live/song/get/tempo");
      const result = { connected: true, controlLayer: "Control Deck Bridge", protocol: "ableton-control-deck/1", host: process.env.CONTROL_DECK_HOST ?? "127.0.0.1", port: Number(process.env.CONTROL_DECK_PORT ?? 50711), tempo: reply.args[0] };
      await this.logger.write({ tool: "ableton_status", args: {}, liveRequest: { address: "/live/song/get/tempo" }, response: reply, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool: "ableton_status", data: result, confirmation: reply };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, dryRun: false, tool: "ableton_status", data: { connected: false }, error: { code: "ABLETON_UNAVAILABLE", message } };
    }
  }

  async getTempo(): Promise<ToolResult> {
    try {
      const reply = await this.live.query("/live/song/get/tempo");
      return { ok: true, dryRun: false, tool: "get_tempo", data: { tempo: Number(reply.args[0]) }, confirmation: reply };
    } catch (error) { return { ok: false, dryRun: false, tool: "get_tempo", error: { code: "ABLETON_UNAVAILABLE", message: (error as Error).message } }; }
  }

  setTempo(tempo: number, dryRun = false): Promise<ToolResult> {
    tempoSchema.parse(tempo);
    return this.run("set_tempo", { tempo, dryRun }, { address: "/live/song/set/tempo", args: [oscFloat(tempo)] }, dryRun, async () => {
      const reply = await this.live.query("/live/song/get/tempo");
      if (Math.abs(Number(reply.args[0]) - tempo) > 0.01) throw new Error(`Tempo verification failed: expected ${tempo}, received ${reply.args[0]}`);
      return { tempo: Number(reply.args[0]) };
    });
  }

  async listTracks(): Promise<ToolResult> {
    try {
      const reply = await this.live.query("/live/song/get/track_names");
      return { ok: true, dryRun: false, tool: "list_tracks", data: { tracks: reply.args.map((name, index) => ({ index, id: `track:${index}`, name: String(name) })) }, confirmation: reply };
    } catch (error) { return { ok: false, dryRun: false, tool: "list_tracks", error: { code: "ABLETON_UNAVAILABLE", message: (error as Error).message } }; }
  }

  async createMidiTrack(index: number, dryRun = false): Promise<ToolResult> {
    return this.createTrack("create_midi_track", "/live/song/create_midi_track", index, dryRun);
  }

  async createAudioTrack(index: number, dryRun = false): Promise<ToolResult> {
    return this.createTrack("create_audio_track", "/live/song/create_audio_track", index, dryRun);
  }

  private async createTrack(tool: "create_midi_track" | "create_audio_track", address: string, index: number, dryRun: boolean): Promise<ToolResult> {
    zIndex(index);
    if (dryRun) return this.run(tool, { index, dryRun }, { address, args: [oscInt(index)] }, true);
    const before = (await this.live.query("/live/song/get/track_names")).args.map(String);
    return this.run(tool, { index, dryRun }, { address, args: [oscInt(index)] }, false, async () => {
      const tracks = await this.waitForTrackCount(before.length + 1);
      return { createdTrackIndex: index === -1 ? before.length : index, id: `track:${index === -1 ? before.length : index}`, tracks };
    });
  }

  renameTrack(trackIndex: number, name: string, dryRun = false): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    if (!name.trim()) throw new Error("Track name must not be empty.");
    return this.run("rename_track", { trackIndex, name, dryRun }, { address: "/live/track/set/name", args: [oscInt(trackIndex), name] }, dryRun, async () => {
      const reply = await this.live.query("/live/track/get/name", [oscInt(trackIndex)]);
      if (String(reply.args.at(-1)) !== name) throw new Error(`Track rename verification failed for track:${trackIndex}`);
      return { trackIndex, id: `track:${trackIndex}`, name };
    });
  }

  createMidiClip(trackIndex: number, sceneIndex: number, lengthBeats: number, dryRun = false): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex); sceneIndexSchema.parse(sceneIndex);
    if (!(lengthBeats > 0)) throw new Error("Clip length must be positive.");
    return this.run("create_midi_clip", { trackIndex, sceneIndex, lengthBeats, dryRun }, { address: "/live/clip_slot/create_clip", args: [oscInt(trackIndex), oscInt(sceneIndex), oscFloat(lengthBeats)] }, dryRun, async () => {
      const reply = await this.live.query("/live/clip_slot/get/has_clip", [oscInt(trackIndex), oscInt(sceneIndex)]);
      if (!Boolean(reply.args.at(-1))) throw new Error("Ableton did not confirm clip creation.");
      return { trackIndex, sceneIndex, lengthBeats };
    });
  }

  async addMidiNotes(trackIndex: number, sceneIndex: number, notes: MidiNote[], dryRun = false): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex); sceneIndexSchema.parse(sceneIndex);
    const valid = validateNotes(notes);
    if (valid.length > MAX_NOTES_PER_CALL) throw new Error(`At most ${MAX_NOTES_PER_CALL} notes can be added at once.`);
    const address = "/live/clip/add/notes";
    const prefix: OscArgument[] = [oscInt(trackIndex), oscInt(sceneIndex)];
    const encode = (note: typeof valid[number]): OscArgument[] => [oscInt(note.pitch), oscFloat(note.startTime), oscFloat(note.duration), oscInt(note.velocity), note.mute];
    let chunks: typeof valid[];
    try {
      chunks = chunkOscNotes(this.live, valid, { address, prefix, maxPerChunk: SESSION_ADD_NOTES_PER_DATAGRAM, encode });
    } catch (error) {
      if (error instanceof DatagramBudgetError) return { ok: false, dryRun: false, tool: "add_midi_notes", error: { code: "REQUEST_TOO_LARGE", message: error.message } };
      throw error;
    }
    const operations = chunks.map(chunk => ({ address, args: [...prefix, ...chunk.flatMap(note => encode(note))] }));
    const started = performance.now();
    const logged = { trackIndex, sceneIndex, notes: valid, dryRun };
    if (dryRun || this.defaultDryRun) {
      await this.logger.write({ tool: "add_midi_notes", args: logged, liveOperation: operations, durationMs: performance.now() - started, success: true, dryRun: true });
      return { ok: true, dryRun: true, tool: "add_midi_notes", intendedOperations: operations };
    }
    try {
      await sendChunksSequentially(chunks, async chunk => {
        await this.live.send(address, [...prefix, ...chunk.flatMap(note => encode(note))]);
      });
    } catch (error) {
      if (error instanceof NoteBatchPartialError) {
        await this.logger.write({ tool: "add_midi_notes", args: logged, durationMs: performance.now() - started, success: false, error: error.message, notesLanded: error.notesLanded });
        return { ok: false, dryRun: false, tool: "add_midi_notes", error: noteBatchErrorBody(error) };
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.write({ tool: "add_midi_notes", args: logged, durationMs: performance.now() - started, success: false, error: message });
      return { ok: false, dryRun: false, tool: "add_midi_notes", error: { code: "ABLETON_OPERATION_FAILED", message } };
    }
    try {
      const reply = await this.live.query("/live/clip/get/notes", [oscInt(trackIndex), oscInt(sceneIndex)]);
      // The reply is track, scene, then pitch, start, duration, velocity, mute per note (no ids).
      const body = reply.args.slice(2);
      const actual = [];
      for (let offset = 0; offset + 4 < body.length; offset += 5) {
        actual.push({ noteId: offset / 5, pitch: Number(body[offset]), startTime: Number(body[offset + 1]), duration: Number(body[offset + 2]), velocity: Number(body[offset + 3]), mute: body[offset + 4] === true });
      }
      try { verifyAddedNotes(valid, actual, `the clip at track ${trackIndex}, scene ${sceneIndex}`); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logger.write({ tool: "add_midi_notes", args: logged, durationMs: performance.now() - started, success: false, error: message });
        return { ok: false, dryRun: false, tool: "add_midi_notes", error: { code: "NOTE_VERIFICATION_FAILED", message } };
      }
      const data = { trackIndex, sceneIndex, noteCountRequested: valid.length, noteCountInClip: actual.length, chunks: chunks.length, chunkNoteCounts: chunks.map(chunk => chunk.length), notesReply: reply.args };
      await this.logger.write({ tool: "add_midi_notes", args: logged, liveOperation: operations, response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool: "add_midi_notes", data };
    } catch (error) {
      const failure = readBackFailed(valid.length, chunks.length, error);
      await this.logger.write({ tool: "add_midi_notes", args: logged, durationMs: performance.now() - started, success: false, error: failure.message, notesLanded: failure.notesLanded });
      return { ok: false, dryRun: false, tool: "add_midi_notes", error: noteBatchErrorBody(failure) };
    }
  }

  async deleteTrack(trackIndex: number, confirm: boolean, dryRun = false): Promise<ToolResult> {
    trackIndexSchema.parse(trackIndex);
    if (!confirm && !dryRun) throw new Error("delete_track requires confirm=true.");
    if (dryRun) return this.run("delete_track", { trackIndex, confirm, dryRun }, { address: "/live/song/delete_track", args: [oscInt(trackIndex)] }, true);
    const before = (await this.live.query("/live/song/get/track_names")).args.map(String);
    if (trackIndex >= before.length) throw new Error(`Track index ${trackIndex} does not exist.`);
    return this.run("delete_track", { trackIndex, confirm, dryRun }, { address: "/live/song/delete_track", args: [oscInt(trackIndex)] }, false, async () => ({ tracks: await this.waitForTrackCount(before.length - 1) }));
  }

  private async waitForTrackCount(expected: number): Promise<string[]> {
    let latest: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      latest = (await this.live.query("/live/song/get/track_names")).args.map(String);
      if (latest.length === expected) return latest;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error(`Track-count verification failed: expected ${expected}, received ${latest.length}`);
  }
}

function zIndex(index: number): void {
  if (!Number.isInteger(index) || index < -1) throw new Error("Track insertion index must be -1 (append) or a non-negative integer.");
}
