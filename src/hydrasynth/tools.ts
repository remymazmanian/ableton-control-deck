import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { JsonLogger } from "../logger.js";
import type { ToolResult } from "../types.js";
import { loadHydrasynthConfig, type HydrasynthConfig } from "./config.js";
import { HydrasynthMidiUnavailable, listEasymidiOutputs, openEasymidiPort, type MidiTransport } from "./midi.js";
import { buildNrpnMessages, midiHex, NRPN_GAP_MS } from "./messages.js";
import { resolvePatch, type PatchRequest } from "./patch.js";
import { BPM_SYNC_OFF, HYDRA_PARAMETERS, HYDRA_SOURCES, PITCH_DRIFT_OFF, type ParameterGroup } from "./parameters.js";
import { encodeSysex, parseSlot, performPatchDump, plannedDumpInfo, sysexFileBytes } from "./sysex.js";

const LIMITATIONS = [
  "Phase 1 sends NRPN to the edit buffer and can request one stored slot. It does not write bank slots.",
  "Only the mapped parameters are sent. Mutant modes, the mod matrix, macros, the arp, and the other envelopes stay as they are.",
  "For a predictable start, select Init on the Hydrasynth, then apply. Save on the front panel if you want to keep the result.",
  "There is no documented SysEx request for the edit buffer. hydra_dump_current reads a bank slot. Save on the panel first if the edit buffer has unsaved changes.",
  "SysEx was reverse engineered against firmware 1.5.5 and 2.0.0. Firmware 2.2.0 is accepted and reported, and is not confirmed on hardware here."
];

export interface HydrasynthToolDependencies {
  loadConfig?: () => Promise<HydrasynthConfig>;
  listPorts?: () => Promise<string[]>;
  openTransport?: (portName: string) => Promise<MidiTransport>;
  logger?: { write(record: Record<string, unknown>): Promise<void> };
  defaultDryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>(resolveTimer => { setTimeout(resolveTimer, ms); });

export class HydrasynthTools {
  private readonly loadConfig: () => Promise<HydrasynthConfig>;
  private readonly listPortsFn: () => Promise<string[]>;
  private readonly openTransport: (portName: string) => Promise<MidiTransport>;
  private readonly logger: { write(record: Record<string, unknown>): Promise<void> };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly dependencies: HydrasynthToolDependencies = {}) {
    this.loadConfig = dependencies.loadConfig ?? (() => loadHydrasynthConfig());
    this.listPortsFn = dependencies.listPorts ?? listEasymidiOutputs;
    this.openTransport = dependencies.openTransport ?? openEasymidiPort;
    this.logger = dependencies.logger ?? new JsonLogger();
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? (() => new Date());
  }

  async listParameters(input: { group?: ParameterGroup } = {}): Promise<ToolResult> {
    const parameters = HYDRA_PARAMETERS.filter(parameter => !input.group || parameter.group === input.group).map(parameter => ({
      id: parameter.id,
      group: parameter.group,
      nrpn: `${parameter.nrpnMsb.toString(16).padStart(2, "0")} ${parameter.nrpnLsb.toString(16).padStart(2, "0")}`,
      min: parameter.min,
      max: parameter.max,
      init: parameter.init,
      encode: parameter.kind,
      unit: parameter.unit
    }));
    return {
      ok: true,
      dryRun: false,
      tool: "hydra_list_parameters",
      data: {
        count: parameters.length,
        parameters,
        bpmSyncSentWithEveryApply: BPM_SYNC_OFF.map(companion => companion.id),
        pitchDriftLock: PITCH_DRIFT_OFF,
        sources: HYDRA_SOURCES,
        limitations: LIMITATIONS
      }
    };
  }

  async listPorts(): Promise<ToolResult> {
    const started = performance.now();
    try {
      const ports = await this.listPortsFn();
      const config = await this.readConfig();
      const data = { ports, configuredPortName: config?.portName ?? "", channel: config?.channel ?? null };
      await this.logger.write({ tool: "hydra_list_ports", response: data, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool: "hydra_list_ports", data };
    } catch (error) {
      return this.failure("hydra_list_ports", started, error);
    }
  }

  async applyPatch(input: PatchRequest & { dryRun?: boolean; portName?: string; channel?: number }): Promise<ToolResult> {
    const started = performance.now();
    try {
      const config = await this.loadConfig();
      const channel = input.channel ?? config.channel;
      const resolved = resolvePatch(input);
      const messages = buildNrpnMessages(channel, resolved.parameters);
      const dryRun = input.dryRun === true || this.dependencies.defaultDryRun === true;
      const data = {
        channel,
        portName: input.portName ?? config.portName,
        pitchDriftLocked: resolved.pitchDriftLocked,
        description: resolved.description,
        describedKeys: resolved.describedKeys,
        parameters: resolved.parameters,
        nrpnCount: messages.length,
        gapMs: NRPN_GAP_MS,
        messages: messages.map(message => ({
          id: message.id,
          nrpn: `${message.nrpnMsb.toString(16).padStart(2, "0")} ${message.nrpnLsb.toString(16).padStart(2, "0")}`,
          modelValue: message.modelValue,
          nrpnValue: message.nrpnValue,
          bytes: message.bytes.map(midiHex)
        })),
        sent: false,
        limitations: LIMITATIONS
      };
      if (dryRun) {
        await this.logger.write({ tool: "hydra_apply_patch", args: { description: input.description, dryRun: true, channel }, response: { nrpnCount: messages.length, pitchDriftLocked: resolved.pitchDriftLocked }, durationMs: performance.now() - started, success: true, dryRun: true });
        return {
          ok: true,
          dryRun: true,
          tool: "hydra_apply_patch",
          data,
          intendedOperations: messages.map(message => ({ address: `midi://nrpn/${message.id}`, args: message.bytes.flat() }))
        };
      }
      const portName = (input.portName ?? config.portName).trim();
      if (!portName) throw new Error("No MIDI port is configured. Set portName in config/hydrasynth.json, or pass portName. hydra_list_ports shows the names. Pass dryRun true to build the NRPN bytes without a port.");
      const transport = await this.openTransport(portName);
      try {
        for (let index = 0; index < messages.length; index += 1) {
          for (const bytes of messages[index]!.bytes) await transport.send(bytes);
          if (index < messages.length - 1) await this.sleep(NRPN_GAP_MS);
        }
      } finally {
        await transport.close();
      }
      data.sent = true;
      await this.logger.write({ tool: "hydra_apply_patch", args: { description: input.description, portName, channel }, response: { nrpnCount: messages.length, sent: true }, durationMs: performance.now() - started, success: true });
      return { ok: true, dryRun: false, tool: "hydra_apply_patch", data };
    } catch (error) {
      return this.failure("hydra_apply_patch", started, error);
    }
  }

  async dumpCurrent(input: { bank: number | string; program: number; outputPath?: string; dryRun?: boolean; portName?: string; timeoutMs?: number }): Promise<ToolResult> {
    const started = performance.now();
    try {
      const config = await this.loadConfig();
      const slot = parseSlot(input.bank, input.program);
      const planned = plannedDumpInfo(slot).map(info => ({ info: midiHex(info), sysex: midiHex(encodeSysex(info)) }));
      const dryRun = input.dryRun === true || this.dependencies.defaultDryRun === true;
      const outputPath = this.outputPath(config.sysexDirectory, slot.bankLetter, slot.panelProgram, input.outputPath);
      if (planned.some(message => message.info.startsWith("14 "))) throw new Error("Refusing to build a bank-slot write.");
      if (dryRun) {
        const data = {
          bank: slot.bankLetter,
          bankIndex: slot.bank,
          panelProgram: slot.panelProgram,
          programIndex: slot.programIndex,
          outputPath,
          wroteFile: false,
          requests: planned,
          limitations: LIMITATIONS
        };
        await this.logger.write({ tool: "hydra_dump_current", args: { bank: slot.bankLetter, program: slot.panelProgram, dryRun: true }, durationMs: performance.now() - started, success: true, dryRun: true });
        return {
          ok: true,
          dryRun: true,
          tool: "hydra_dump_current",
          data,
          intendedOperations: planned.map(message => ({ address: "midi://sysex", args: message.sysex.split(" ").map(byte => Number.parseInt(byte, 16)) }))
        };
      }
      const portName = (input.portName ?? config.portName).trim();
      if (!portName) throw new Error("No MIDI port is configured. Set portName in config/hydrasynth.json. Pass dryRun true to build the SysEx request without a port.");
      const transport = await this.openTransport(portName);
      let capture;
      try {
        capture = await performPatchDump(transport, slot, input.timeoutMs ?? 2000);
      } finally {
        await transport.close();
      }
      if (capture.sentInfo.some(info => info[0] === 0x14)) throw new Error("Bank-slot write was not part of this dump and must not be sent.");
      const wroteFile = capture.received.length > 0;
      if (wroteFile) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, sysexFileBytes(capture.received));
      }
      const data = {
        bank: slot.bankLetter,
        bankIndex: slot.bank,
        panelProgram: slot.panelProgram,
        programIndex: slot.programIndex,
        outputPath: wroteFile ? outputPath : null,
        wroteFile,
        footerSent: capture.footerSent,
        receivedCount: capture.received.length,
        summary: capture.summary,
        limitations: LIMITATIONS
      };
      const transferComplete = capture.footerSent && capture.summary.structurallyComplete;
      await this.logger.write({ tool: "hydra_dump_current", args: { bank: slot.bankLetter, program: slot.panelProgram, portName }, response: { wroteFile, transferComplete, warnings: capture.summary.warnings }, durationMs: performance.now() - started, success: transferComplete });
      if (!transferComplete) {
        return { ok: false, dryRun: false, tool: "hydra_dump_current", data, error: { code: "HYDRASYNTH_DUMP_INCOMPLETE", message: capture.summary.warnings[0] ?? "The SysEx dump did not complete." } };
      }
      return { ok: true, dryRun: false, tool: "hydra_dump_current", data };
    } catch (error) {
      return this.failure("hydra_dump_current", started, error);
    }
  }

  private outputPath(directory: string, bankLetter: string, panelProgram: number, requested?: string): string {
    if (requested) {
      if (!requested.toLowerCase().endsWith(".syx")) throw new Error("Dump outputPath must end in .syx.");
      return isAbsolute(requested) ? requested : resolve(directory, requested);
    }
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    return resolve(directory, `hydrasynth-${bankLetter.toLowerCase()}${String(panelProgram).padStart(3, "0")}-${stamp}.syx`);
  }

  private async readConfig(): Promise<HydrasynthConfig | null> {
    try { return await this.loadConfig(); } catch { return null; }
  }

  private async failure(tool: string, started: number, error: unknown): Promise<ToolResult> {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof HydrasynthMidiUnavailable ? "HYDRASYNTH_MIDI_UNAVAILABLE" : "HYDRASYNTH_ERROR";
    await this.logger.write({ tool, durationMs: performance.now() - started, success: false, error: message });
    return { ok: false, dryRun: false, tool, error: { code, message } };
  }
}
