import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fromProjectRoot } from "../paths.js";

export interface HydrasynthConfig {
  portName: string;
  channel: number;
  sysexDirectory: string;
  source: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadHydrasynthConfig(explicitPath?: string): Promise<HydrasynthConfig> {
  const override = fromProjectRoot("config/hydrasynth.json");
  const example = fromProjectRoot("config/hydrasynth.example.json");
  const source = explicitPath ?? (await exists(override) ? override : example);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Hydrasynth config at ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Hydrasynth config at ${source} must be a JSON object.`);
  const record = parsed as Record<string, unknown>;
  if (typeof record.portName !== "string") throw new Error("Hydrasynth config portName must be a string. Use an empty string until hydra_list_ports shows the USB port.");
  if (typeof record.channel !== "number" || !Number.isInteger(record.channel) || record.channel < 1 || record.channel > 16) {
    throw new Error("Hydrasynth config channel must be an integer from 1 to 16.");
  }
  if (typeof record.sysexDirectory !== "string" || !record.sysexDirectory.trim()) throw new Error("Hydrasynth config sysexDirectory must be a path.");
  const sysexDirectory = isAbsolute(record.sysexDirectory) ? record.sysexDirectory : fromProjectRoot(record.sysexDirectory);
  return { portName: record.portName, channel: record.channel, sysexDirectory: resolve(sysexDirectory), source };
}
