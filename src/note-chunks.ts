import { liveCommandDatagramBytes } from "./ableton-client.js";
import type { LiveControlClient, OscArgument } from "./types.js";

/**
 * Target size for one note-write datagram. macOS rejects a UDP send around
 * 9216 bytes (`EMSGSIZE`). The remote script accepts up to 32768. 7 KB stays
 * under both, with room for a longer bridge token than the measurer saw.
 */
export const NOTE_DATAGRAM_BUDGET_BYTES = 7 * 1024;

/**
 * Most notes one tool call accepts. Each call is still split into datagrams
 * before it reaches the bridge.
 */
export const MAX_NOTES_PER_CALL = 10_000;

/**
 * Control_Deck.py rejects an arrangement add or modify above this count.
 * Session `add_midi_notes` has no matching cap; the 4096-arg limit applies there.
 */
export const BRIDGE_NOTES_PER_DATAGRAM = 256;

/** `_live_request` refuses a command with more than this many args. */
export const LIVE_MAX_COMMAND_ARGS = 4096;

const FALLBACK_TOKEN = "t".repeat(128);

export function maxNotesInCommand(headerArgs: number, fieldsPerNote: number): number {
  if (fieldsPerNote < 1 || headerArgs < 0 || headerArgs >= LIVE_MAX_COMMAND_ARGS) {
    throw new Error("Note fields do not fit in one Live command.");
  }
  return Math.floor((LIVE_MAX_COMMAND_ARGS - headerArgs) / fieldsPerNote);
}

export const ARRANGEMENT_ADD_NOTES_PER_DATAGRAM = Math.min(BRIDGE_NOTES_PER_DATAGRAM, maxNotesInCommand(4, 5));
export const ARRANGEMENT_MODIFY_NOTES_PER_DATAGRAM = Math.min(BRIDGE_NOTES_PER_DATAGRAM, maxNotesInCommand(4, 6));
export const SESSION_ADD_NOTES_PER_DATAGRAM = maxNotesInCommand(2, 5);

export class DatagramBudgetError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`Request too large: one note serializes to ${bytes} bytes, over the ${maxBytes}-byte datagram budget.`);
    this.name = "DatagramBudgetError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export interface NoteBatchDetails {
  notesLanded: number;
  notesRequested: number;
  chunksCompleted: number;
  chunksPlanned: number;
  phase: "send" | "read-back";
}

export class NoteBatchPartialError extends Error implements NoteBatchDetails {
  readonly notesLanded: number;
  readonly notesRequested: number;
  readonly chunksCompleted: number;
  readonly chunksPlanned: number;
  readonly phase: "send" | "read-back";
  override readonly cause: unknown;

  constructor(details: NoteBatchDetails & { cause: unknown }) {
    const causeText = details.cause instanceof Error ? details.cause.message : String(details.cause);
    const message = details.phase === "read-back"
      ? `All ${details.notesRequested} notes were sent in ${details.chunksPlanned} batches, then read-back failed. ${causeText}`
      : `Note write stopped after ${details.notesLanded} of ${details.notesRequested} notes landed (${details.chunksCompleted} of ${details.chunksPlanned} batches). ${causeText}`;
    super(message, { cause: details.cause });
    this.name = "NoteBatchPartialError";
    this.notesLanded = details.notesLanded;
    this.notesRequested = details.notesRequested;
    this.chunksCompleted = details.chunksCompleted;
    this.chunksPlanned = details.chunksPlanned;
    this.phase = details.phase;
    this.cause = details.cause;
  }
}

export function noteBatchErrorBody(error: NoteBatchPartialError): { code: string; message: string; details: NoteBatchDetails } {
  return {
    code: error.phase === "send" ? "NOTE_BATCH_PARTIAL" : "ABLETON_OPERATION_FAILED",
    message: error.message,
    details: {
      notesLanded: error.notesLanded,
      notesRequested: error.notesRequested,
      chunksCompleted: error.chunksCompleted,
      chunksPlanned: error.chunksPlanned,
      phase: error.phase
    }
  };
}

/**
 * Split `items` so each slice stays within `maxBytes` of `serializedBytes` and
 * within `maxPerChunk` items. Order is preserved. A single item over the byte
 * budget throws DatagramBudgetError instead of sending it.
 */
export function chunkBySerializedBytes<T>(items: readonly T[], options: {
  maxBytes: number;
  maxPerChunk: number;
  serializedBytes: (slice: readonly T[]) => number;
}): T[][] {
  if (!Number.isInteger(options.maxPerChunk) || options.maxPerChunk < 1) throw new Error("maxPerChunk must be a positive integer.");
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) throw new Error("maxBytes must be positive.");
  const chunks: T[][] = [];
  let offset = 0;
  while (offset < items.length) {
    const upper = Math.min(options.maxPerChunk, items.length - offset);
    const single = options.serializedBytes(items.slice(offset, offset + 1));
    if (single > options.maxBytes) throw new DatagramBudgetError(single, options.maxBytes);
    let low = 1;
    let high = upper;
    let best = 1;
    while (low <= high) {
      const mid = Math.ceil((low + high) / 2);
      const bytes = options.serializedBytes(items.slice(offset, offset + mid));
      if (bytes <= options.maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    chunks.push(items.slice(offset, offset + best));
    offset += best;
  }
  return chunks;
}

export async function sendChunksSequentially<T>(chunks: readonly (readonly T[])[], send: (chunk: readonly T[], index: number) => Promise<void>): Promise<void> {
  const notesRequested = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  let notesLanded = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      await send(chunks[index], index);
    } catch (cause) {
      throw new NoteBatchPartialError({
        notesLanded,
        notesRequested,
        chunksCompleted: index,
        chunksPlanned: chunks.length,
        phase: "send",
        cause
      });
    }
    notesLanded += chunks[index].length;
  }
}

export function readBackFailed(notesRequested: number, chunksPlanned: number, cause: unknown): NoteBatchPartialError {
  return new NoteBatchPartialError({
    notesLanded: notesRequested,
    notesRequested,
    chunksCompleted: chunksPlanned,
    chunksPlanned,
    phase: "read-back",
    cause
  });
}

function plainArgument(value: OscArgument): string | number | boolean {
  return typeof value === "object" ? value.value : value;
}

/** Byte length of the datagram `AbletonClient.send` would transmit for these args. */
export function measureCommandBytes(live: LiveControlClient, address: string, args: readonly OscArgument[]): number {
  if (typeof live.commandBytes === "function") return live.commandBytes(address, args);
  return liveCommandDatagramBytes(FALLBACK_TOKEN, address, args.map(plainArgument));
}

export function chunkOscNotes<T>(live: LiveControlClient, items: readonly T[], options: {
  address: string;
  prefix: readonly OscArgument[];
  encode: (item: T) => readonly OscArgument[];
  maxPerChunk: number;
  maxBytes?: number;
}): T[][] {
  const maxBytes = options.maxBytes ?? NOTE_DATAGRAM_BUDGET_BYTES;
  return chunkBySerializedBytes(items, {
    maxBytes,
    maxPerChunk: options.maxPerChunk,
    serializedBytes: slice => measureCommandBytes(live, options.address, [
      ...options.prefix,
      ...slice.flatMap(item => options.encode(item))
    ])
  });
}
