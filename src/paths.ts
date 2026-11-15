import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { machineTokenPath } from "./machine-token.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = basename(dirname(moduleDirectory)) === "dist"
  ? resolve(moduleDirectory, "../..")
  : resolve(moduleDirectory, "..");

/** The same rule as dataRoot in platform.mjs; tests/platform.test.ts checks the two agree. */
export function dataRootFor(root: string, home?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CONTROL_DECK_DATA) return resolve(env.CONTROL_DECK_DATA);
  if (existsSync(join(root, "packaged.json"))) return dirname(machineTokenPath(home, env, platform));
  return root;
}

export const dataRoot = dataRootFor(projectRoot);

/** Files shipped with Control Deck (package.json, config/templates.json). */
export const fromProjectRoot = (path: string): string => resolve(projectRoot, path);

/** Files Control Deck writes: settings, indexes, snapshots, and logs. */
export const fromDataRoot = (path: string): string => resolve(dataRoot, path);
