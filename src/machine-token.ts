import { homedir } from "node:os";
import path from "node:path";

/** The same location as machineTokenPath in platform.mjs; tests/platform.test.ts checks the two agree. */
export function machineTokenPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || home, "AppData", "Local"), "Ableton Control Deck", "bridge-token");
  return path.join(home, "Library", "Application Support", "Ableton Control Deck", "bridge-token");
}
