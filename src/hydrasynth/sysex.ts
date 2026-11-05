/**
 * Hydrasynth SysEx, from Sean Luke's reverse engineering.
 *
 * Encoding (1 May 2023), checked by Edisyn against firmware 1.5.5 and 2.0.0:
 * https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/SysexEncoding.txt
 *
 * Patch layout (updated 12 Dec 2025). The author believes 2.2.0 uses the same
 * layout as 2.0.0 and stores its version as byte 0xDC. That has not been
 * confirmed on a 2.2.0 Desktop in this repository:
 * https://github.com/eclab/edisyn/blob/master/edisyn/synth/asmhydrasynth/info/SysexPatchFormat.txt
 *
 * There is no documented request for the edit buffer. A dump asks for one
 * bank slot. Unsaved NRPN edits are not in that slot until they are saved on
 * the panel. This module builds the read handshake only. The slot-write
 * command (info 14 00) is intentionally absent.
 */

const ASM_ID = [0x00, 0x20, 0x2b, 0x00, 0x6f];
const BANK_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export const KNOWN_PATCH_VERSIONS: Record<number, string> = {
  0x9b: "1.5.5",
  0xc8: "2.0.0",
  0xdc: "2.2.0"
};

export interface HydraSlot {
  bank: number;
  bankLetter: string;
  /** Panel number 1-128. SysEx uses this minus one. */
  panelProgram: number;
  programIndex: number;
}

export interface DecodedSysex {
  info: number[];
  checksumOk: boolean;
}

export interface PatchSummary {
  byteLength: number;
  /** All 22 chunks arrived at the documented lengths and total 2790 bytes. Layout warnings do not clear this. */
  structurallyComplete: boolean;
  versionByte: number | null;
  version: string | null;
  versionKnown: boolean;
  name: string | null;
  embeddedBank: number | null;
  embeddedProgramIndex: number | null;
  notes: string[];
  warnings: string[];
}

export interface MidiExchange {
  send(bytes: number[]): Promise<void>;
  receive(timeoutMs: number): Promise<number[] | null>;
}

export interface DumpCapture {
  slot: HydraSlot;
  received: number[][];
  sentInfo: number[][];
  chunks: Array<number[] | undefined>;
  summary: PatchSummary;
  footerSent: boolean;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 of the info bytes, bitwise NOT, little-endian. Matches SysexEncoding.txt's worked example. */
export function sysexChecksum(info: number[]): number[] {
  const inverted = (~crc32(Uint8Array.from(info))) >>> 0;
  return [inverted & 0xff, (inverted >>> 8) & 0xff, (inverted >>> 16) & 0xff, (inverted >>> 24) & 0xff];
}

export function encodeSysex(info: number[]): number[] {
  const payload = Buffer.from([...sysexChecksum(info), ...info]);
  const ascii = [...payload.toString("base64")].map(character => character.charCodeAt(0));
  return [0xf0, ...ASM_ID, ...ascii, 0xf7];
}

export function decodeSysexMessage(message: number[]): DecodedSysex | null {
  let bytes = message;
  if (bytes[0] === 0xf0) bytes = bytes.slice(1);
  if (bytes.at(-1) === 0xf7) bytes = bytes.slice(0, -1);
  if (bytes.length < 5 || bytes[0] !== ASM_ID[0] || bytes[1] !== ASM_ID[1] || bytes[2] !== ASM_ID[2] || bytes[3] !== ASM_ID[3] || bytes[4] !== ASM_ID[4]) return null;
  let ascii = String.fromCharCode(...bytes.slice(5)).replace(/\s+/g, "");
  if (!ascii || !/^[A-Za-z0-9+/=]+$/.test(ascii)) return null;
  while (ascii.length % 4 !== 0) ascii += "=";
  const payload = Buffer.from(ascii, "base64");
  if (payload.length < 4) return null;
  const info = [...payload.subarray(4)];
  const expected = sysexChecksum(info);
  const checksumOk = payload[0] === expected[0] && payload[1] === expected[1] && payload[2] === expected[2] && payload[3] === expected[3];
  return { info, checksumOk };
}

export function parseSlot(bank: number | string, program: number): HydraSlot {
  let bankIndex: number;
  if (typeof bank === "number") {
    if (!Number.isInteger(bank) || bank < 0 || bank > 7) throw new Error("Hydrasynth bank must be 0-7 or a letter A-H.");
    bankIndex = bank;
  } else {
    bankIndex = BANK_LETTERS.indexOf(bank.trim().toUpperCase() as typeof BANK_LETTERS[number]);
    if (bankIndex < 0) throw new Error("Hydrasynth bank must be 0-7 or a letter A-H.");
  }
  if (!Number.isInteger(program) || program < 1 || program > 128) throw new Error("Hydrasynth program is the panel number, from 1 to 128.");
  return { bank: bankIndex, bankLetter: BANK_LETTERS[bankIndex]!, panelProgram: program, programIndex: program - 1 };
}

export function patchRequestInfo(slot: HydraSlot): number[] {
  return [0x04, 0x00, slot.bank, slot.programIndex];
}

export function plannedDumpInfo(slot: HydraSlot): number[][] {
  const acks = Array.from({ length: 22 }, (_, chunk) => [0x17, 0x00, chunk, 0x16]);
  return [[0x18, 0x00], patchRequestInfo(slot), ...acks, [0x1a, 0x00]];
}

export function parseChunkInfo(info: number[]): { chunk: number; data: number[] } | null {
  if (info.length < 4 || info[0] !== 0x16 || info[1] !== 0x00 || info[3] !== 0x16) return null;
  return { chunk: info[2] ?? -1, data: info.slice(4) };
}

export function summarizePatch(chunks: Array<number[] | undefined>): PatchSummary {
  const warnings: string[] = [];
  const notes: string[] = [];
  const parts: number[] = [];
  let chunksPresent = true;
  let lengthsMatch = true;
  for (let index = 0; index < 22; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      chunksPresent = false;
      warnings.push(`Missing chunk ${index}. Bytes after the gap are not decoded.`);
      break;
    }
    const expected = index === 21 ? 102 : 128;
    if (chunk.length !== expected) {
      lengthsMatch = false;
      warnings.push(`Chunk ${index} is ${chunk.length} bytes; the 1.5.5/2.0.0 dump uses ${expected}.`);
    }
    parts.push(...chunk);
  }
  const bytes = Uint8Array.from(parts);
  const versionByte = bytes.length > 4 ? bytes[4]! : null;
  const version = versionByte === null ? null : KNOWN_PATCH_VERSIONS[versionByte] ?? null;
  if (versionByte === 0xdc) {
    notes.push("Firmware byte 0xDC is the value Edisyn records for 2.2.0. The 12 Dec 2025 patch note says this layout matches 2.0.0. This repository has not confirmed that on a 2.2.0 Desktop.");
  } else if (versionByte !== null && version === null) {
    warnings.push(`Firmware byte 0x${versionByte.toString(16).padStart(2, "0")} is not 1.5.5 (0x9B), 2.0.0 (0xC8), or 2.2.0 (0xDC). The field readout below still uses the 2.0.0 offsets and may be wrong.`);
  } else if (versionByte === 0x9b) {
    notes.push("Firmware byte 0x9B is 1.5.5. Vibrato amount and some mod sources differ from 2.0.0. Name and version are the fields treated as safe.");
  }
  if (chunksPresent && bytes.length !== 2790) warnings.push(`Chunk set is ${bytes.length} bytes; Edisyn's decoded patch is 2790.`);
  let name: string | null = null;
  if (bytes.length >= 25) name = Buffer.from(bytes.subarray(9, 25)).toString("latin1").replace(/\0/g, "").trim();
  if (bytes.length >= 1770) {
    const marker = [bytes[1766], bytes[1767], bytes[1768], bytes[1769]];
    const standard = marker.join(",") === "69,84,67,68" || marker.join(",") === "88,88,88,88";
    if (!standard) warnings.push(`Marker bytes 1766-1769 are ${marker.join(" ")}; Edisyn expects 69 84 67 68 or 88 88 88 88.`);
  }
  return {
    byteLength: bytes.length,
    structurallyComplete: chunksPresent && lengthsMatch && bytes.length === 2790,
    versionByte,
    version,
    versionKnown: version !== null,
    name,
    embeddedBank: bytes.length > 2 ? bytes[2]! : null,
    embeddedProgramIndex: bytes.length > 3 ? bytes[3]! : null,
    notes,
    warnings
  };
}

export function sysexFileBytes(messages: number[][]): Buffer {
  return Buffer.concat(messages.map(message => Buffer.from(message[0] === 0xf0 ? message : [0xf0, ...message, 0xf7])));
}

export async function performPatchDump(io: MidiExchange, slot: HydraSlot, timeoutMs = 2000): Promise<DumpCapture> {
  const received: number[][] = [];
  const sentInfo: number[][] = [];
  const chunks: Array<number[] | undefined> = Array.from({ length: 22 }, () => undefined);
  const warnings: string[] = [];
  let footerSent = false;

  const sendInfo = async (info: number[]) => {
    sentInfo.push(info);
    await io.send(encodeSysex(info));
  };
  const take = async (): Promise<{ state: "timeout" } | { state: "ignored" } | { state: "ok"; decoded: DecodedSysex }> => {
    const message = await io.receive(timeoutMs);
    if (!message) return { state: "timeout" };
    received.push(message[0] === 0xf0 ? message : [0xf0, ...message, 0xf7]);
    const decoded = decodeSysexMessage(message);
    if (!decoded?.checksumOk) return { state: "ignored" };
    return { state: "ok", decoded };
  };

  try {
    await sendInfo([0x18, 0x00]);
    const header = await take();
    if (header.state === "timeout") warnings.push("No header response. Expected info 19 00.");
    else if (header.state === "ignored") warnings.push("Header response was not a valid ASM SysEx message. The front-panel Send Patch stream (F0 01 ...) is a different encoding and is not decoded.");
    else if (header.decoded.info[0] !== 0x19) warnings.push(`Header response started with ${header.decoded.info[0].toString(16)}; expected 19.`);

    await sendInfo(patchRequestInfo(slot));
    for (let expected = 0; expected < 22; expected += 1) {
      const incoming = await take();
      if (incoming.state !== "ok") {
        warnings.push(incoming.state === "timeout"
          ? `Stopped at chunk ${expected}. The synth may still be in the dump handshake until the footer.`
          : `Chunk ${expected} failed the CRC-32 check or was not ASM SysEx, so it was not decoded.`);
        break;
      }
      const parsed = parseChunkInfo(incoming.decoded.info);
      if (!parsed || parsed.chunk < 0 || parsed.chunk > 21) {
        warnings.push(`Response while waiting for chunk ${expected} was not a chunk dump.`);
        break;
      }
      chunks[parsed.chunk] = parsed.data;
      if (parsed.chunk !== expected) warnings.push(`Expected chunk ${expected} and received chunk ${parsed.chunk}.`);
      await sendInfo([0x17, 0x00, parsed.chunk, 0x16]);
      if (parsed.chunk !== expected) break;
    }
  } finally {
    try {
      await sendInfo([0x1a, 0x00]);
      footerSent = true;
      const footer = await take();
      if (footer.state === "timeout") warnings.push("No footer response. The footer was still sent so the panel can release. Edisyn notes the panel stays sluggish for about 20 seconds if the footer is skipped.");
      else if (footer.state === "ignored") warnings.push("Footer response failed the checksum or was not ASM SysEx. The footer was still sent.");
      else if (footer.decoded.info[0] !== 0x1b) warnings.push(`Footer response started with ${footer.decoded.info[0].toString(16)}; expected 1B.`);
    } catch (error) {
      warnings.push(`Footer was not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const summary = summarizePatch(chunks);
  summary.warnings.unshift(...warnings);
  return { slot, received, sentInfo, chunks, summary, footerSent };
}
