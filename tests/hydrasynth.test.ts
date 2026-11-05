import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadHydrasynthConfig } from "../src/hydrasynth/config.js";
import { normalizeSysex, partitionMidi, type MidiTransport } from "../src/hydrasynth/midi.js";
import { buildNrpnMessages, midiHex } from "../src/hydrasynth/messages.js";
import { resolvePatch } from "../src/hydrasynth/patch.js";
import { HYDRA_PARAMETERS, encodeModelValue, parameterById } from "../src/hydrasynth/parameters.js";
import { decodeSysexMessage, encodeSysex, performPatchDump, summarizePatch, sysexChecksum } from "../src/hydrasynth/sysex.js";
import { HydrasynthTools } from "../src/hydrasynth/tools.js";
import { fromProjectRoot } from "../src/paths.js";

const logger = { write: vi.fn() };
const config = { portName: "Hydrasynth Desktop", channel: 1, sysexDirectory: "/tmp/hydra-sysex", source: "test" };

function tools(extra: ConstructorParameters<typeof HydrasynthTools>[0] = {}) {
  return new HydrasynthTools({ logger, loadConfig: async () => config, sleep: async () => {}, now: () => new Date("2026-11-05T00:00:00.000Z"), ...extra });
}

function message(id: string, channel = 1) {
  const found = buildNrpnMessages(channel, resolvePatch({}).parameters).find(item => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("Hydrasynth NRPN bytes", () => {
  it("covers the key oscillator, mixer, filter, envelope, LFO, and effect parameters", () => {
    expect(HYDRA_PARAMETERS.length).toBeGreaterThanOrEqual(40);
    expect(HYDRA_PARAMETERS.length).toBeLessThanOrEqual(60);
    expect(HYDRA_PARAMETERS.length).toBe(59);
    const groups = new Set(HYDRA_PARAMETERS.map(parameter => parameter.group));
    expect(groups).toEqual(new Set(["oscillator", "mixer", "mutant", "filter", "amp", "envelope", "lfo", "effect", "voice"]));
  });

  it("builds the documented CC 99/98/6/38 order without a MIDI port", () => {
    expect(message("osc1cent").bytes.map(midiHex)).toEqual(["b0 63 41", "b0 62 01", "b0 06 00", "b0 26 00"]);
    expect(message("osc1cent", 2).bytes[0]).toEqual([0xb1, 0x63, 0x41]);
    expect(encodeModelValue(parameterById("osc1cent")!, -50)).toBe(8142);
    expect(message("filter1cutoff").bytes.map(midiHex)).toEqual(["b0 63 40", "b0 62 28", "b0 06 40", "b0 26 00"]);
    expect(buildNrpnMessages(1, resolvePatch({ parameters: { osc2mode: 1 } }).parameters).find(item => item.id === "osc2mode")!.bytes.map(midiHex)).toEqual([
      "b0 63 3f", "b0 62 18", "b0 06 01", "b0 26 01"
    ]);
    expect(message("osc3semi").bytes.map(midiHex)).toEqual(["b0 63 3f", "b0 62 11", "b0 06 02", "b0 26 74"]);
    expect(buildNrpnMessages(1, resolvePatch({ parameters: { delaytype: 2 } }).parameters).find(item => item.id === "delaytype")!.nrpnValue).toBe(16);
    expect(message("voicedetune").bytes.map(midiHex)).toEqual(["b0 63 3f", "b0 62 39", "b0 06 00", "b0 26 20"]);
    expect(message("env1bpmsync").bytes.map(midiHex)).toEqual(["b0 63 3f", "b0 62 00", "b0 06 0c", "b0 26 00"]);
  });

  it("sends modes, then types, then the LFO wave, then BPM sync, then the rest", () => {
    const ids = buildNrpnMessages(1, resolvePatch({}).parameters).map(item => item.id);
    expect(ids.indexOf("osc1mode")).toBeLessThan(ids.indexOf("osc1type"));
    expect(ids.indexOf("osc1type")).toBeLessThan(ids.indexOf("lfo1wave"));
    expect(ids.indexOf("lfo1wave")).toBeLessThan(ids.indexOf("env1bpmsync"));
    expect(ids.indexOf("env1bpmsync")).toBeLessThan(ids.indexOf("filter1cutoff"));
    expect(ids.filter(id => id.endsWith("bpmsync"))).toEqual(["env1bpmsync", "env2bpmsync", "lfo1bpmsync", "delaybpmsync"]);
  });
});

describe("Hydrasynth patch resolution", () => {
  it("starts from the decoded Init baseline", () => {
    const patch = resolvePatch({});
    expect(patch.parameters.osc1type).toBe(3);
    expect(patch.parameters.mixerosc1vol).toBe(1024);
    expect(patch.parameters.mixerosc2vol).toBe(0);
    expect(patch.parameters.filter1cutoff).toBe(1024);
    expect(patch.parameters.voicedetune).toBe(32);
    expect(patch.parameters.voicevibratoamount).toBe(2);
    expect(patch.parameters.voicewarmmode).toBe(0);
    expect(patch.parameters.mutant1wet).toBe(0);
    expect(patch.pitchDriftLocked).toBe(false);
  });

  it("turns a warm soft pad with no pitch drift into a locked patch", () => {
    const patch = resolvePatch({ description: "warm soft pad, no pitch drift" });
    expect(patch.pitchDriftLocked).toBe(true);
    expect(patch.parameters).toMatchObject({
      filter1cutoff: 320,
      filter1resonance: 40,
      env2attacksyncoff: 520,
      osc2type: 0,
      mixerosc2vol: 700,
      reverbwet: 340,
      voicedetune: 0,
      voiceanalogfeel: 0,
      voicevibratoamount: 0,
      voicewarmmode: 0,
      osc1cent: 0,
      osc2cent: 0,
      osc3cent: 0,
      filter1lfo1amount: 512
    });
  });

  it("keeps an explicit detune unless the description locks pitch drift", () => {
    expect(resolvePatch({ parameters: { voicedetune: 40 } }).parameters.voicedetune).toBe(40);
    expect(resolvePatch({ description: "no pitch drift", parameters: { voicedetune: 40, filter1cutoff: 100 } }).parameters).toMatchObject({
      voicedetune: 0,
      filter1cutoff: 100
    });
  });

  it("does not treat the word warm as Warm Mode", () => {
    expect(resolvePatch({ description: "warm" }).parameters.voicewarmmode).toBe(0);
  });

  it("rejects unknown and out-of-range parameters", () => {
    expect(() => resolvePatch({ parameters: { env1bpmsync: 0 } })).toThrow(/Unknown Hydrasynth parameter/);
    expect(() => resolvePatch({ parameters: { filter1cutoff: 1025 } })).toThrow(/filter1cutoff/);
  });
});

describe("Hydrasynth SysEx", () => {
  it("matches Edisyn's worked request for bank A patch 128", () => {
    expect(sysexChecksum([0x04, 0x00, 0x00, 0x7f])).toEqual([0x19, 0xdb, 0x63, 0x91]);
    expect(encodeSysex([0x04, 0x00, 0x00, 0x7f])).toEqual([
      0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f,
      0x47, 0x64, 0x74, 0x6a, 0x6b, 0x51, 0x51, 0x41, 0x41, 0x48, 0x38, 0x3d,
      0xf7
    ]);
    const decoded = decodeSysexMessage(encodeSysex([0x04, 0x00, 0x00, 0x7f]));
    expect(decoded).toMatchObject({ checksumOk: true, info: [0x04, 0x00, 0x00, 0x7f] });
  });

  it("reports an unknown firmware byte without dropping the bytes", () => {
    const patch = syntheticPatch(0x11, "Mystery");
    const summary = summarizePatch(chunkPatch(patch).map(info => info.slice(4)));
    expect(summary.structurallyComplete).toBe(true);
    expect(summary.version).toBeNull();
    expect(summary.name).toBe("Mystery");
    expect(summary.warnings.join(" ")).toMatch(/0x11/);
  });

  it("notes that 2.2.0 uses the 2.0.0 layout only as an Edisyn belief", () => {
    const summary = summarizePatch(chunkPatch(syntheticPatch(0xdc, "Desktop")).map(info => info.slice(4)));
    expect(summary).toMatchObject({ version: "2.2.0", versionKnown: true, structurallyComplete: true, name: "Desktop" });
    expect(summary.notes.join(" ")).toMatch(/not confirmed/);
  });

  it("acks every chunk, sends the footer, and never sends a slot write", async () => {
    const patch = syntheticPatch(0xdc, "Phase One");
    const responses = [
      encodeSysex([0x19, 0x00]),
      ...chunkPatch(patch).map(info => encodeSysex(info)),
      encodeSysex([0x1b, 0x00])
    ];
    const io = scripted(responses);
    const slot = { bank: 1, bankLetter: "B", panelProgram: 16, programIndex: 15 };
    const capture = await performPatchDump(io, slot, 20);
    const sentInfo = capture.sentInfo;
    expect(sentInfo[0]).toEqual([0x18, 0x00]);
    expect(sentInfo[1]).toEqual([0x04, 0x00, 0x01, 0x0f]);
    expect(sentInfo.at(-1)).toEqual([0x1a, 0x00]);
    expect(sentInfo.some(info => info[0] === 0x14)).toBe(false);
    expect(capture.footerSent).toBe(true);
    expect(capture.summary).toMatchObject({ structurallyComplete: true, version: "2.2.0", name: "Phase One", embeddedBank: 1, embeddedProgramIndex: 15 });
  });

  it("still sends the footer when a chunk never arrives", async () => {
    const io = scripted([encodeSysex([0x19, 0x00]), null]);
    const capture = await performPatchDump(io, { bank: 0, bankLetter: "A", panelProgram: 1, programIndex: 0 }, 5);
    expect(capture.sentInfo.map(info => info[0])).toEqual([0x18, 0x04, 0x1a]);
    expect(capture.summary.structurallyComplete).toBe(false);
    expect(capture.footerSent).toBe(true);
  });
});

describe("Hydrasynth tools", () => {
  it("dry-runs a description into NRPN bytes and does not open a port", async () => {
    const openTransport = vi.fn();
    const result = await tools({ openTransport }).applyPatch({ description: "warm soft pad, no pitch drift", dryRun: true });
    expect(openTransport).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.data).toMatchObject({ sent: false, pitchDriftLocked: true, parameters: { voicedetune: 0, filter1cutoff: 320 } });
    const messages = (result.data as { messages: Array<{ id: string; bytes: string[] }> }).messages;
    expect(messages.find(item => item.id === "osc1cent")?.bytes).toEqual(["b0 63 41", "b0 62 01", "b0 06 00", "b0 26 00"]);
    expect(result.intendedOperations?.[0]?.args.length).toBe(12);
  });

  it("sends the CC bytes on a configured port and stays silent when the port is blank", async () => {
    const sent: number[][] = [];
    const openTransport = vi.fn(async (): Promise<MidiTransport> => ({
      send: async bytes => { sent.push(bytes); },
      receive: async () => null,
      close: async () => {}
    }));
    const live = await tools({ openTransport }).applyPatch({ description: "pad", parameters: { osc1cent: -1 } });
    expect(live).toMatchObject({ ok: true, dryRun: false, data: { sent: true } });
    expect(sent[0]).toEqual([0xb0, 0x63, 0x3f]);
    expect(openTransport).toHaveBeenCalledWith("Hydrasynth Desktop");
    const blocked = await tools({ openTransport, loadConfig: async () => ({ ...config, portName: "" }) }).applyPatch({});
    expect(blocked).toMatchObject({ ok: false, error: { code: "HYDRASYNTH_ERROR" } });
  });

  it("honors the process dry-run switch", async () => {
    const openTransport = vi.fn();
    const result = await tools({ openTransport, defaultDryRun: true }).applyPatch({ dryRun: false });
    expect(result.dryRun).toBe(true);
    expect(openTransport).not.toHaveBeenCalled();
  });

  it("dry-runs the A128 request as the documented SysEx message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydra-dry-"));
    const result = await tools({ loadConfig: async () => ({ ...config, sysexDirectory: directory }) }).dumpCurrent({ bank: "A", program: 128, dryRun: true });
    expect(result.dryRun).toBe(true);
    const requests = (result.data as { requests: Array<{ info: string; sysex: string }>; wroteFile: boolean }).requests;
    expect(requests[1]).toMatchObject({
      info: "04 00 00 7f",
      sysex: "f0 00 20 2b 00 6f 47 64 74 6a 6b 51 51 41 41 48 38 3d f7"
    });
    expect(requests.some(request => request.info.startsWith("14 "))).toBe(false);
    expect((result.data as { wroteFile: boolean }).wroteFile).toBe(false);
  });

  it("writes a .syx from a scripted 2.2.0 slot dump", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydra-dump-"));
    const patch = syntheticPatch(0xdc, "Boards");
    const responses = [encodeSysex([0x19, 0x00]), ...chunkPatch(patch).map(info => encodeSysex(info)), encodeSysex([0x1b, 0x00])];
    const transport = scripted(responses);
    const result = await tools({
      loadConfig: async () => ({ ...config, sysexDirectory: directory }),
      openTransport: async () => transport
    }).dumpCurrent({ bank: "B", program: 16 });
    expect(result.ok).toBe(true);
    const outputPath = (result.data as { outputPath: string }).outputPath;
    expect(outputPath.endsWith(".syx")).toBe(true);
    const file = [...await readFile(outputPath)];
    expect(file[0]).toBe(0xf0);
    expect(file.at(-1)).toBe(0xf7);
    const chunkData = splitSysex(file)
      .map(message => decodeSysexMessage(message)?.info)
      .filter((info): info is number[] => info?.[0] === 0x16)
      .map(info => info.slice(4));
    const summary = summarizePatch(chunkData);
    expect(summary).toMatchObject({ name: "Boards", version: "2.2.0", structurallyComplete: true });
    expect(transport.sent.some(bytes => decodeSysexMessage(bytes)?.info[0] === 0x14)).toBe(false);
  });

  it("reads the example config", async () => {
    const loaded = await loadHydrasynthConfig(fromProjectRoot("config/hydrasynth.example.json"));
    expect(loaded).toMatchObject({ portName: "", channel: 1 });
    expect(loaded.sysexDirectory.endsWith("/data/hydrasynth")).toBe(true);
  });
});

describe("MIDI message partition", () => {
  it("separates channel CC from SysEx and wraps a bare payload", () => {
    expect(partitionMidi([0xb0, 0x63, 0x41])).toEqual({ kind: "cc", channel: 0, controller: 0x63, value: 0x41 });
    expect(partitionMidi([0xf0, 0x00, 0xf7])).toEqual({ kind: "sysex", bytes: [0xf0, 0x00, 0xf7] });
    expect(normalizeSysex([0x00, 0x20])).toEqual([0xf0, 0x00, 0x20, 0xf7]);
  });
});

function syntheticPatch(version: number, name: string): number[] {
  const bytes = Array.from({ length: 2790 }, () => 0);
  bytes[2] = 1;
  bytes[3] = 15;
  bytes[4] = version;
  const encoded = Buffer.from(name.padEnd(16, " ").slice(0, 16), "latin1");
  for (let index = 0; index < 16; index += 1) bytes[9 + index] = encoded[index] ?? 0x20;
  bytes[1766] = 69;
  bytes[1767] = 84;
  bytes[1768] = 67;
  bytes[1769] = 68;
  return bytes;
}

function chunkPatch(patch: number[]): number[][] {
  const chunks: number[][] = [];
  let offset = 0;
  for (let chunk = 0; chunk < 22; chunk += 1) {
    const size = chunk === 21 ? 102 : 128;
    chunks.push([0x16, 0x00, chunk, 0x16, ...patch.slice(offset, offset + size)]);
    offset += size;
  }
  return chunks;
}

function scripted(responses: Array<number[] | null>): MidiTransport & { sent: number[][] } {
  const pending = [...responses];
  const sent: number[][] = [];
  return {
    sent,
    async send(bytes: number[]) { sent.push(bytes); },
    async receive() { return pending.shift() ?? null; },
    async close() {}
  };
}

function splitSysex(bytes: number[]): number[][] {
  const messages: number[][] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf(0xf0, cursor);
    const end = bytes.indexOf(0xf7, start);
    if (start < 0 || end < 0) break;
    messages.push(bytes.slice(start, end + 1));
    cursor = end + 1;
  }
  return messages;
}
