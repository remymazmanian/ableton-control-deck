/**
 * Optional USB MIDI. `easymidi` is not a dependency of this package, so CI can
 * build NRPN and SysEx bytes without a native MIDI library or a Hydrasynth.
 * Install it on the Mac that has the instrument: `npm install easymidi`.
 */

export interface MidiTransport {
  send(bytes: number[]): Promise<void>;
  receive(timeoutMs: number): Promise<number[] | null>;
  close(): Promise<void>;
}

export class HydrasynthMidiUnavailable extends Error {
  constructor() {
    super("USB MIDI needs the optional easymidi package on the Mac attached to the Hydrasynth. From the Control Deck folder run: npm install easymidi. Dry-run does not need it, and this does not write a bank slot.");
    this.name = "HydrasynthMidiUnavailable";
  }
}

interface EasymidiOutput {
  send(type: "cc", message: { channel: number; controller: number; value: number }): void;
  send(type: "sysex", message: number[]): void;
  close(): void;
}

interface EasymidiInput {
  on(event: "sysex", listener: (message: number[]) => void): void;
  close(): void;
}

interface EasymidiApi {
  getOutputs(): string[];
  getInputs(): string[];
  Output: new (name: string) => EasymidiOutput;
  Input: new (name: string) => EasymidiInput;
}

export function partitionMidi(bytes: number[]): { kind: "cc"; channel: number; controller: number; value: number } | { kind: "sysex"; bytes: number[] } {
  if (bytes[0] === 0xf0 && bytes.at(-1) === 0xf7) return { kind: "sysex", bytes };
  if (bytes.length === 3 && (bytes[0]! & 0xf0) === 0xb0) return { kind: "cc", channel: bytes[0]! & 0x0f, controller: bytes[1]!, value: bytes[2]! };
  throw new Error(`Only Hydrasynth CC and SysEx messages are sent. Refusing ${bytes.map(byte => byte.toString(16)).join(" ")}.`);
}

export function normalizeSysex(bytes: number[]): number[] {
  if (bytes[0] === 0xf0 && bytes.at(-1) === 0xf7) return bytes;
  return [0xf0, ...bytes.filter(byte => byte !== 0xf0 && byte !== 0xf7), 0xf7];
}

async function importEasymidi(): Promise<EasymidiApi> {
  try {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<EasymidiApi>;
    const loaded = await importer("easymidi");
    if (typeof loaded.getOutputs !== "function" || typeof loaded.Output !== "function") throw new HydrasynthMidiUnavailable();
    return loaded;
  } catch (error) {
    if (error instanceof HydrasynthMidiUnavailable) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") throw new HydrasynthMidiUnavailable();
    throw error;
  }
}

export async function listEasymidiOutputs(): Promise<string[]> {
  const midi = await importEasymidi();
  return midi.getOutputs();
}

export async function openEasymidiPort(portName: string): Promise<MidiTransport> {
  if (!portName.trim()) throw new Error("Set portName in config/hydrasynth.json to a name from hydra_list_ports.");
  const midi = await importEasymidi();
  const outputs = midi.getOutputs();
  if (!outputs.includes(portName)) throw new Error(`MIDI output "${portName}" is not open. hydra_list_ports currently sees: ${outputs.join(", ") || "(none)"}.`);
  const output = new midi.Output(portName);
  const inputs = typeof midi.getInputs === "function" ? midi.getInputs() : [];
  const input = inputs.includes(portName) ? new midi.Input(portName) : null;
  const queue: number[][] = [];
  let waiter: ((bytes: number[]) => void) | null = null;
  input?.on("sysex", message => {
    const normalized = normalizeSysex(message);
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending(normalized);
    } else queue.push(normalized);
  });
  let closed = false;
  return {
    async send(bytes: number[]): Promise<void> {
      const message = partitionMidi(bytes);
      if (message.kind === "cc") output.send("cc", { channel: message.channel, controller: message.controller, value: message.value });
      else output.send("sysex", message.bytes);
    },
    receive(timeoutMs: number): Promise<number[] | null> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (!input) return Promise.resolve(null);
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, timeoutMs);
        waiter = bytes => {
          clearTimeout(timer);
          resolve(bytes);
        };
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      input?.close();
      output.close();
    }
  };
}
