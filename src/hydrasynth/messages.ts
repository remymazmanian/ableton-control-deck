import { BPM_SYNC_OFF, encodeModelValue, HYDRA_PARAMETERS, type ParameterOrder } from "./parameters.js";

/** Pause after each complete NRPN. Edisyn warns the Hydrasynth drops parameters if they arrive in a blast. */
export const NRPN_GAP_MS = 5;

const ORDER_RANK: Record<ParameterOrder, number> = { mode: 0, type: 1, lfoWave: 2, bpmSync: 3, rest: 4 };

export interface NrpnMessage {
  id: string;
  order: ParameterOrder;
  nrpnMsb: number;
  nrpnLsb: number;
  modelValue: number | null;
  nrpnValue: number;
  bytes: number[][];
}

export function midiHex(bytes: number[]): string {
  return bytes.map(byte => byte.toString(16).padStart(2, "0")).join(" ");
}

export function controlChange(channel: number, controller: number, value: number): number[] {
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) throw new Error("MIDI channel must be an integer from 1 to 16.");
  if (!Number.isInteger(controller) || controller < 0 || controller > 127) throw new Error("MIDI controller must be 0-127.");
  if (!Number.isInteger(value) || value < 0 || value > 127) throw new Error("MIDI control value must be 0-127.");
  return [0xb0 | (channel - 1), controller, value];
}

/** Four control changes: CC 99, CC 98, CC 6, CC 38. Both data bytes are always sent. */
export function nrpnBytes(channel: number, nrpnMsb: number, nrpnLsb: number, nrpnValue: number): number[][] {
  if (!Number.isInteger(nrpnMsb) || nrpnMsb < 0 || nrpnMsb > 127 || !Number.isInteger(nrpnLsb) || nrpnLsb < 0 || nrpnLsb > 127) {
    throw new Error("NRPN address bytes must be 0-127.");
  }
  if (!Number.isInteger(nrpnValue) || nrpnValue < 0 || nrpnValue > 16383) throw new Error("NRPN value must fit in 14 bits.");
  return [
    controlChange(channel, 99, nrpnMsb),
    controlChange(channel, 98, nrpnLsb),
    controlChange(channel, 6, (nrpnValue >> 7) & 0x7f),
    controlChange(channel, 38, nrpnValue & 0x7f)
  ];
}

export function buildNrpnMessages(channel: number, values: Record<string, number>): NrpnMessage[] {
  const messages: NrpnMessage[] = HYDRA_PARAMETERS.map(parameter => {
    const modelValue = values[parameter.id];
    if (modelValue === undefined) throw new Error(`Missing Hydrasynth value for ${parameter.id}.`);
    const nrpnValue = encodeModelValue(parameter, modelValue);
    return {
      id: parameter.id,
      order: parameter.order,
      nrpnMsb: parameter.nrpnMsb,
      nrpnLsb: parameter.nrpnLsb,
      modelValue,
      nrpnValue,
      bytes: nrpnBytes(channel, parameter.nrpnMsb, parameter.nrpnLsb, nrpnValue)
    };
  });
  for (const companion of BPM_SYNC_OFF) {
    messages.push({
      id: companion.id,
      order: "bpmSync",
      nrpnMsb: companion.nrpnMsb,
      nrpnLsb: companion.nrpnLsb,
      modelValue: null,
      nrpnValue: companion.nrpnValue,
      bytes: nrpnBytes(channel, companion.nrpnMsb, companion.nrpnLsb, companion.nrpnValue)
    });
  }
  return messages.sort((left, right) => ORDER_RANK[left.order] - ORDER_RANK[right.order]);
}
