const CLIP_FIELDS = 4;
export const MAX_ARRANGEMENT_BEATS = 1_576_800;
const TIME_TOLERANCE = 0.001;

export interface ArrangementClipDescriptor {
  index: number;
  name: string;
  startBeats: number;
  endBeats: number;
  lengthBeats: number;
  kind: "midi" | "audio" | "unknown";
}

export function parseArrangementClips(args: readonly unknown[], expectedTrackIndex?: number): ArrangementClipDescriptor[] {
  if (args.length < 1) throw new Error("Arrangement clip reply is missing the track index.");
  if (expectedTrackIndex !== undefined && Number(args[0]) !== expectedTrackIndex) {
    throw new Error(`Arrangement clip reply was addressed to track ${String(args[0])}, not track ${expectedTrackIndex}.`);
  }
  const body = args.slice(1);
  if (body.length % CLIP_FIELDS !== 0) {
    throw new Error("Arrangement clip reply is missing clip type. Reinstall the Control Deck remote script and restart Live.");
  }
  const clips: ArrangementClipDescriptor[] = [];
  for (let offset = 0; offset < body.length; offset += CLIP_FIELDS) {
    const name = body[offset];
    if (typeof name !== "string") throw new Error("Arrangement clip name was not text.");
    const startBeats = finiteNumber(body[offset + 1], "clip start");
    const endBeats = finiteNumber(body[offset + 2], "clip end");
    clips.push({
      index: clips.length,
      name,
      startBeats,
      endBeats,
      lengthBeats: endBeats - startBeats,
      kind: clipKind(body[offset + 3])
    });
  }
  return clips;
}

export function findCreatedMidiClip(clips: readonly ArrangementClipDescriptor[], startBeats: number, lengthBeats: number, name?: string): ArrangementClipDescriptor {
  const endBeats = startBeats + lengthBeats;
  const matches = clips.filter(clip => clip.kind === "midi" && Math.abs(clip.startBeats - startBeats) < TIME_TOLERANCE && Math.abs(clip.endBeats - endBeats) < TIME_TOLERANCE);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "Live did not confirm the arrangement MIDI clip." : "More than one arrangement MIDI clip matches that start and length.");
  }
  const clip = matches[0];
  if (name !== undefined && clip.name !== name) throw new Error(`Arrangement clip name verification failed: expected '${name}', found '${clip.name}'.`);
  return clip;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Arrangement ${label} was not a finite number.`);
  return value;
}

function clipKind(value: unknown): ArrangementClipDescriptor["kind"] {
  if (value === "midi" || value === "audio" || value === "unknown") return value;
  throw new Error(`Unexpected arrangement clip type '${String(value)}'.`);
}
