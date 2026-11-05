/**
 * Live's track and master volume (`mixer_device.volume`) is a normalized
 * DeviceParameter from 0 to 1. 0 is silence, 0.85 is 0 dB, and 1 is +6 dB.
 * Ableton does not publish the curve. The piecewise fit below is the one
 * recorded against that fader (anchors 0 dB = 0.85, +6 dB = 1, -18 dB = 0.4).
 * The tool sends the normalized value and returns both it and the display
 * string Live stored. Trust the display string: it is `str_for_value` of the
 * value Live kept.
 *
 * Accepted range is -70 dB through +6 dB. -70 dB is sent as 0, which Live
 * shows as silence rather than the number -70.
 */
export const LIVE_VOLUME_DB_MIN = -70;
export const LIVE_VOLUME_DB_MAX = 6;

const MID_ALPHA = 799.503788;
const MID_BETA = 12630.61132;
const MID_GAMMA = 201.871345;
const MID_DELTA = 399.751894;
const LOW_BETA = 118.426374;
const LOW_GAMMA = 7504 / 5567;

export function dbToLiveVolume(db: number): number {
  if (!Number.isFinite(db)) throw new Error("Volume must be a finite number of dB.");
  if (db > LIVE_VOLUME_DB_MAX || db < LIVE_VOLUME_DB_MIN) {
    throw new Error(`Volume must be from ${LIVE_VOLUME_DB_MIN} dB to +${LIVE_VOLUME_DB_MAX} dB.`);
  }
  if (db <= LIVE_VOLUME_DB_MIN) return 0;
  if (db >= -18) return (db + 34) / 40;
  if (db >= -41) return -(Math.sqrt(-MID_ALPHA * db - MID_BETA) - MID_GAMMA) / MID_DELTA;
  return Math.pow((db + 70) / LOW_BETA, LOW_GAMMA);
}

/** Inverse of {@link dbToLiveVolume}. 0 maps to silence, not to -70 dB. */
export function liveVolumeToDb(value: number): number {
  if (!(value > 0)) return Number.NEGATIVE_INFINITY;
  if (value >= 0.4) return 40 * value - 34;
  if (value >= 0.15) return -((MID_DELTA * value - MID_GAMMA) ** 2 + MID_BETA) / MID_ALPHA;
  return LOW_BETA * Math.pow(value, 1 / LOW_GAMMA) - 70;
}

export function reportedVolumeDb(value: number): number | null {
  const db = liveVolumeToDb(value);
  if (!Number.isFinite(db)) return null;
  return Math.round(db * 100) / 100;
}

export function assertPan(pan: number): void {
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) throw new Error("Pan must be from -1 (left) to 1 (right).");
}

export function assertSendLevel(level: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(level) || level < minimum || level > maximum) {
    throw new Error(`Send level must be from ${minimum} to ${maximum}. 0 is silence and 1 is unity (0 dB) on a standard send.`);
  }
}

export interface MixerSend {
  index: number;
  name: string;
  returnName: string;
  level: number;
  minimum: number;
  maximum: number;
  displayValue: string;
}

export interface TrackMixer {
  index: number;
  name: string;
  volume: number;
  volumeDisplay: string;
  db: number | null;
  pan: number;
  panDisplay: string;
  muted: boolean;
  soloed: boolean;
  sends: MixerSend[];
}

export interface MasterVolume {
  volume: number;
  displayValue: string;
  db: number | null;
}

const MIXER_HEADER = 7;
const SEND_FIELDS = 7;

export function parseMasterVolumeReply(args: readonly unknown[]): MasterVolume {
  if (args.length < 2) throw new Error("Master volume reply is truncated. Reinstall the Control Deck remote script and restart Live.");
  const volume = finiteNumber(args[0], "master volume");
  return { volume, displayValue: String(args[1]), db: reportedVolumeDb(volume) };
}

export function parseTrackMixerReply(args: readonly unknown[], trackName: string): TrackMixer {
  if (args.length < MIXER_HEADER || (args.length - MIXER_HEADER) % SEND_FIELDS !== 0) {
    throw new Error("Mixer reply is truncated. Reinstall the Control Deck remote script and restart Live.");
  }
  const sends: MixerSend[] = [];
  for (let offset = MIXER_HEADER; offset < args.length; offset += SEND_FIELDS) {
    sends.push({
      index: wholeNumber(args[offset], "send index"),
      name: String(args[offset + 1]),
      returnName: String(args[offset + 2]),
      level: finiteNumber(args[offset + 3], "send level"),
      minimum: finiteNumber(args[offset + 4], "send minimum"),
      maximum: finiteNumber(args[offset + 5], "send maximum"),
      displayValue: String(args[offset + 6])
    });
  }
  const volume = finiteNumber(args[1], "volume");
  return {
    index: wholeNumber(args[0], "track index"),
    name: trackName,
    volume,
    volumeDisplay: String(args[2]),
    db: reportedVolumeDb(volume),
    pan: finiteNumber(args[3], "pan"),
    panDisplay: String(args[4]),
    muted: flag(args[5]),
    soloed: flag(args[6]),
    sends
  };
}

export function resolveSend(sends: readonly MixerSend[], input: { sendIndex?: number; sendName?: string }): MixerSend {
  const { sendIndex, sendName } = input;
  if (sendIndex === undefined && !sendName?.trim()) throw new Error("Provide sendIndex or sendName.");
  if (sendIndex !== undefined) {
    if (!Number.isInteger(sendIndex) || sendIndex < 0) throw new Error("sendIndex must be a non-negative integer.");
    const send = sends.find(item => item.index === sendIndex);
    if (!send) throw new Error(`Send index ${sendIndex} does not exist.`);
    if (sendName !== undefined && send.name !== sendName && send.returnName !== sendName) {
      throw new Error(`Send safeguard failed: expected '${sendName}', found '${send.name}' (return '${send.returnName}') at index ${sendIndex}.`);
    }
    return send;
  }
  const name = sendName as string;
  const matches = sends.filter(item => item.name === name || item.returnName === name);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No send named '${name}'.`);
  throw new Error(`Multiple sends are named '${name}'; provide sendIndex.`);
}

function flag(value: unknown): boolean {
  return value === true || value === 1;
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Mixer ${label} was not an integer.`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Mixer ${label} was not a finite number.`);
  return value;
}
