import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fromProjectRoot } from "./paths.js";

export class JsonLogger {
  constructor(private readonly path = process.env.CONTROL_DECK_LOG ?? fromProjectRoot("logs/control-deck.jsonl")) {}

  async write(record: Record<string, unknown>): Promise<void> {
    const safe = JSON.parse(JSON.stringify(record, (_key, value) =>
      typeof value === "string" && value.startsWith("/Volumes/") ? `<external-volume>/${value.split("/").pop()}` : value
    ));
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...safe })}\n`);
  }
}
