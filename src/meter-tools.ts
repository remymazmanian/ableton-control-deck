import { RackTools } from "./rack-tools.js";
import { parsePlayback, type TrackKind } from "./session-tools.js";
import type { ToolResult } from "./types.js";

/**
 * Live's output meters run 0-1 on a dB-linear scale. Measured in Live 12.4.16 with 1 kHz sine
 * tones at 0, -6, -12, -18, -24, and -36 dBFS: 0 dBFS reads 0.921 and each dB is 0.01316, so
 * 1.0 is about +6 dB and 0 is about -70 dB. The meter moves in steps of about 1.5 dB.
 */
export const METER_AT_0_DBFS = 0.921;
export const METER_PER_DB = 0.01316;
export const METER_STEP_DB = 1.5;
const SILENT = 0.0005;

export function meterToDb(value: number): number {
  if (!Number.isFinite(value) || value <= SILENT) return -Infinity;
  return Math.round(((value - METER_AT_0_DBFS) / METER_PER_DB) * 10) / 10;
}

export interface MeterRow { trackKind: TrackKind; trackIndex: number; name: string; left: number; right: number; mute: boolean; hasAudioOutput: boolean }

export function parseMeters(args: readonly unknown[]): { isPlaying: boolean; rows: MeterRow[] } {
  const count = Number(args[1]);
  const fields = 8;
  if (!Number.isInteger(count) || args.length !== 2 + count * fields) throw new Error("Meter reply has the wrong length. Reinstall the Control Deck remote script and restart Live.");
  const rows: MeterRow[] = [];
  for (let k = 0; k < count; k++) {
    const [kind, index, name, left, right, , mute, hasAudioOutput] = args.slice(2 + k * fields, 2 + (k + 1) * fields);
    rows.push({ trackKind: kind as TrackKind, trackIndex: Number(index), name: String(name), left: Number(left) || 0, right: Number(right) || 0, mute: mute === true, hasAudioOutput: hasAudioOutput !== false });
  }
  return { isPlaying: args[0] === true, rows };
}

/** JSON has no -Infinity, so silence is sent as null alongside a "-inf dB" text value. */
const finite = (db: number): number | null => (Number.isFinite(db) ? db : null);
const dbText = (db: number) => (db === -Infinity ? "-inf dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`);
const key = (row: { trackKind: string; trackIndex: number }) => `${row.trackKind}:${row.trackIndex}`;

export interface TrackLevels {
  trackKind: TrackKind; trackIndex: number; name: string; mute: boolean;
  peakDb: number; averageDb: number; leftDb: number; rightDb: number; silentShare: number;
}

/** Summarize meter samples taken over time into per-track levels. */
export function summarize(samples: ReadonlyArray<{ rows: MeterRow[] }>): TrackLevels[] {
  const byTrack = new Map<string, MeterRow[]>();
  for (const sample of samples) for (const row of sample.rows) byTrack.set(key(row), [...(byTrack.get(key(row)) ?? []), row]);
  const meanDb = (values: number[]) => {
    const heard = values.filter(value => value > SILENT);
    return heard.length ? meterToDb(heard.reduce((sum, value) => sum + value, 0) / heard.length) : -Infinity;
  };
  return [...byTrack.values()].map(rows => {
    const peaks = rows.map(row => Math.max(row.left, row.right));
    const last = rows[rows.length - 1];
    return {
      trackKind: last.trackKind, trackIndex: last.trackIndex, name: last.name, mute: last.mute,
      peakDb: meterToDb(Math.max(...peaks)),
      averageDb: meanDb(peaks),
      leftDb: meanDb(rows.map(row => row.left)),
      rightDb: meanDb(rows.map(row => row.right)),
      silentShare: Math.round((peaks.filter(peak => peak <= SILENT).length / peaks.length) * 100) / 100
    };
  });
}

export interface MixFinding { severity: "problem" | "warning" | "note"; track: string; message: string }

/** Turn per-track levels into findings. playing holds the tracks that are playing a Session clip. */
export function findIssues(levels: readonly TrackLevels[], playing: ReadonlySet<string>): MixFinding[] {
  const findings: MixFinding[] = [];
  const label = (level: TrackLevels) => (level.trackKind === "master" ? "Master" : level.trackKind === "return" ? `Return '${level.name}'` : `'${level.name}'`);
  for (const level of levels) {
    // A reading 1.5 dB over 0 is one meter step, so anything above that is a real overload.
    if (level.peakDb > METER_STEP_DB / 2) findings.push({ severity: "problem", track: level.name, message: `${label(level)} peaks at ${dbText(level.peakDb)}, over 0 dBFS. Turn it or its source down.` });
    else if (level.trackKind === "master" && level.peakDb > -1) findings.push({ severity: "warning", track: level.name, message: `Master peaks at ${dbText(level.peakDb)}, with less than 1 dB of headroom.` });
    if (level.trackKind === "track" && !level.mute && playing.has(key(level)) && level.peakDb === -Infinity) {
      findings.push({ severity: "warning", track: level.name, message: `${label(level)} is playing a clip but makes no sound. Check its instrument, routing, and clip.` });
    }
    if (level.averageDb > -60 && Math.abs(level.leftDb - level.rightDb) >= 6) {
      const side = level.leftDb > level.rightDb ? "left" : "right";
      findings.push({ severity: "note", track: level.name, message: `${label(level)} leans ${side}: left ${dbText(level.leftDb)}, right ${dbText(level.rightDb)} on average.` });
    }
  }
  const tracks = levels.filter(level => level.trackKind === "track" && level.averageDb > -Infinity);
  if (tracks.length > 1) {
    const loudest = tracks.reduce((a, b) => (b.averageDb > a.averageDb ? b : a));
    for (const level of tracks) {
      if (loudest.averageDb - level.averageDb >= 24) findings.push({ severity: "note", track: level.name, message: `${label(level)} sits ${Math.round(loudest.averageDb - level.averageDb)} dB below '${loudest.name}' on average. Check it is meant to be that quiet.` });
    }
  }
  const master = levels.find(level => level.trackKind === "master");
  if (master && master.peakDb === -Infinity) findings.push({ severity: "warning", track: master.name, message: "The master made no sound while sampling. Is anything playing?" });
  return findings;
}

export class MeterTools extends RackTools {
  private async meters() {
    return parseMeters((await this.live.query("/live/meters/get")).args);
  }

  getMeters(): Promise<ToolResult> {
    return this.read("get_meters", async () => {
      const { isPlaying, rows } = await this.meters();
      return {
        isPlaying,
        note: `A snapshot of Live's output meters, in steps of about ${METER_STEP_DB} dB. A dB value of null means silence.${isPlaying ? "" : " Live is stopped, so every meter reads silence."}`,
        tracks: rows.map(row => {
          const [left, right, peak] = [meterToDb(row.left), meterToDb(row.right), meterToDb(Math.max(row.left, row.right))];
          return { trackKind: row.trackKind, trackIndex: row.trackIndex, name: row.name, mute: row.mute, leftDb: finite(left), rightDb: finite(right), peakDb: finite(peak), peak: dbText(peak) };
        })
      };
    });
  }

  mixCheck(input: { seconds?: number } = {}): Promise<ToolResult> {
    const seconds = input.seconds ?? 4;
    return this.read("mix_check", async () => {
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error("seconds must be from 1 to 30.");
      const first = await this.meters();
      if (!first.isPlaying) throw new Error("Live is stopped. Start playback (or fire the clips or scene you want checked), then run mix_check again.");
      const samples = [first];
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 50));
        samples.push(await this.meters());
      }
      const playback = parsePlayback((await this.live.query("/live/session/get/playback")).args);
      const playing = new Set(playback.tracks.filter(track => track.playingSlotIndex >= 0).map(track => `track:${track.trackIndex}`));
      const levels = summarize(samples);
      const findings = findIssues(levels, playing);
      const order = { problem: 0, warning: 1, note: 2 } as const;
      findings.sort((a, b) => order[a.severity] - order[b.severity]);
      return {
        seconds, samples: samples.length,
        summary: findings.length ? `${findings.filter(f => f.severity === "problem").length} problem(s), ${findings.filter(f => f.severity === "warning").length} warning(s), ${findings.filter(f => f.severity === "note").length} note(s).` : "No problems found.",
        findings,
        levels: levels.map(level => ({
          ...level, peakDb: finite(level.peakDb), averageDb: finite(level.averageDb), leftDb: finite(level.leftDb), rightDb: finite(level.rightDb),
          peak: dbText(level.peakDb), average: dbText(level.averageDb)
        })),
        note: `Levels come from Live's output meters, which move in steps of about ${METER_STEP_DB} dB, sampled every 50 ms. Only what plays while sampling is checked.`
      };
    });
  }
}
