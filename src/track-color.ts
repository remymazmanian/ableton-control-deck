/** Live's track color palette. `Track.color_index` selects one of these swatches. */
export const LIVE_PALETTE_MIN = 0;
export const LIVE_PALETTE_MAX = 69;

const RGB_TEXT = /^#([0-9a-fA-F]{6})$/;

export function assertColorIndex(colorIndex: number): void {
  if (!Number.isInteger(colorIndex) || colorIndex < LIVE_PALETTE_MIN || colorIndex > LIVE_PALETTE_MAX) {
    throw new Error(`colorIndex must be an integer from ${LIVE_PALETTE_MIN} to ${LIVE_PALETTE_MAX}.`);
  }
}

/** `#RRGGBB` to the 24-bit integer Live stores on `Track.color`. */
export function parseRgb(rgb: string): number {
  const match = RGB_TEXT.exec(rgb.trim());
  if (!match) throw new Error("rgb must be a color like #RRGGBB.");
  return Number.parseInt(match[1], 16);
}

export function formatRgb(color: number): string {
  if (!Number.isInteger(color)) throw new Error("Track color was not an integer.");
  return `#${((color >>> 0) & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

export interface TrackColor {
  index: number;
  color: number;
  rgb: string;
  colorIndex: number;
}

export function parseTrackColorReply(args: readonly unknown[]): TrackColor {
  if (args.length < 3) throw new Error("Track color reply is truncated. Reinstall the Control Deck remote script and restart Live.");
  const index = wholeNumber(args[0], "track index");
  const color = wholeNumber(args[1], "color");
  const colorIndex = wholeNumber(args[2], "color index");
  return { index, color, rgb: formatRgb(color), colorIndex };
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Track ${label} was not an integer.`);
  return value;
}
