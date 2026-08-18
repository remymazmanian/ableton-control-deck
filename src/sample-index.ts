import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JsonLogger } from "./logger.js";
import { fromProjectRoot } from "./paths.js";

const AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac"]);

interface LibraryConfig { root: string; database: string; favorites: string[]; tags: Record<string, string[]> }
export interface SampleSearch {
  keywords?: string;
  folder?: string;
  sampleType?: string;
  bpmMin?: number;
  bpmMax?: number;
  musicalKey?: string;
  durationMin?: number;
  durationMax?: number;
  kind?: "one-shot" | "loop" | "unknown";
  favoritesOnly?: boolean;
  tags?: string[];
  limit?: number;
}

export class SampleIndex {
  private db?: DatabaseSync;
  private config?: LibraryConfig;
  constructor(private readonly configPath = fromProjectRoot("config/sample-library.json"), private readonly logger = new JsonLogger(), private readonly allowLocalRoot = process.env.NODE_ENV === "test") {}

  private async setup(): Promise<{ db: DatabaseSync; config: LibraryConfig }> {
    if (this.db && this.config) return { db: this.db, config: this.config };
    const config = JSON.parse(await readFile(this.configPath, "utf8")) as LibraryConfig;
    if (!this.allowLocalRoot && !resolve(config.root).startsWith("/Volumes/")) throw new Error("Sample root must be an absolute path on an external volume.");
    await access(config.root, constants.R_OK);
    const databasePath = fromProjectRoot(config.database);
    await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        folder TEXT NOT NULL,
        sample_type TEXT NOT NULL,
        bpm REAL,
        musical_key TEXT,
        duration_seconds REAL,
        kind TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_ms REAL NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        scan_token TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS samples_filename ON samples(filename);
      CREATE INDEX IF NOT EXISTS samples_folder ON samples(folder);
      CREATE INDEX IF NOT EXISTS samples_type ON samples(sample_type);
      CREATE INDEX IF NOT EXISTS samples_bpm ON samples(bpm);
      CREATE INDEX IF NOT EXISTS samples_key ON samples(musical_key);
    `);
    this.db = db; this.config = config;
    return { db, config };
  }

  async refresh(options: { rebuild?: boolean; confirm?: boolean } = {}): Promise<{ indexed: number; removed: number; root: string; database: string; rebuilt: boolean }> {
    if (options.rebuild && !options.confirm) throw new Error("Rebuilding the sample database requires confirm=true.");
    const started = performance.now();
    const { db, config } = await this.setup();
    const databasePath = fromProjectRoot(config.database);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const favorites = new Set(config.favorites.map(path => resolve(config.root, path)));
    const upsert = db.prepare(`INSERT INTO samples
      (path,filename,extension,folder,sample_type,bpm,musical_key,duration_seconds,kind,size_bytes,modified_ms,favorite,tags_json,scan_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET filename=excluded.filename,extension=excluded.extension,folder=excluded.folder,
      sample_type=excluded.sample_type,bpm=excluded.bpm,musical_key=excluded.musical_key,duration_seconds=excluded.duration_seconds,
      kind=excluded.kind,size_bytes=excluded.size_bytes,modified_ms=excluded.modified_ms,favorite=excluded.favorite,
      tags_json=excluded.tags_json,scan_token=excluded.scan_token`);
    if (options.rebuild) db.exec("DELETE FROM samples");
    let indexed = 0;
    db.exec("BEGIN");
    try {
      for await (const path of walk(config.root)) {
        const extension = extname(path).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(extension)) continue;
        const info = await stat(path);
        const rel = relative(config.root, path);
        const inferred = inferMetadata(rel);
        const duration = extension === ".wav" ? await readWavDuration(path) : null;
        const tags = config.tags[rel] ?? [];
        upsert.run(path, basename(path), extension.slice(1), relative(config.root, resolve(path, "..")), inferred.sampleType, inferred.bpm, inferred.musicalKey, duration, inferred.kind, info.size, info.mtimeMs, favorites.has(path) ? 1 : 0, JSON.stringify(tags), token);
        indexed++;
      }
      const before = Number((db.prepare("SELECT count(*) AS count FROM samples WHERE scan_token != ?").get(token) as { count: number }).count);
      db.prepare("DELETE FROM samples WHERE scan_token != ?").run(token);
      db.exec("COMMIT");
      const result = { indexed, removed: before, root: config.root, database: databasePath, rebuilt: Boolean(options.rebuild) };
      await this.logger.write({ tool: "refresh_sample_index", args: options, response: result, durationMs: performance.now() - started, success: true });
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      await this.logger.write({ tool: "refresh_sample_index", args: options, durationMs: performance.now() - started, success: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async search(input: SampleSearch = {}): Promise<{ samples: unknown[]; count: number }> {
    const { db } = await this.setup();
    const where: string[] = []; const values: Array<string | number> = [];
    if (input.keywords) for (const keyword of input.keywords.trim().split(/\s+/)) { where.push("(filename LIKE ? OR folder LIKE ?)"); values.push(`%${keyword}%`, `%${keyword}%`); }
    if (input.folder) { where.push("folder LIKE ?"); values.push(`%${input.folder}%`); }
    if (input.sampleType) { where.push("sample_type = ?"); values.push(input.sampleType.toLowerCase()); }
    if (input.bpmMin !== undefined) { where.push("bpm >= ?"); values.push(input.bpmMin); }
    if (input.bpmMax !== undefined) { where.push("bpm <= ?"); values.push(input.bpmMax); }
    if (input.musicalKey) { where.push("lower(musical_key) = lower(?)"); values.push(input.musicalKey); }
    if (input.durationMin !== undefined) { where.push("duration_seconds >= ?"); values.push(input.durationMin); }
    if (input.durationMax !== undefined) { where.push("duration_seconds <= ?"); values.push(input.durationMax); }
    if (input.kind) { where.push("kind = ?"); values.push(input.kind); }
    if (input.favoritesOnly) where.push("favorite = 1");
    if (input.tags?.length) for (const tag of input.tags) { where.push("tags_json LIKE ?"); values.push(`%\"${tag}\"%`); }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const sql = `SELECT id,path,filename,extension,folder,sample_type,bpm,musical_key,duration_seconds,kind,size_bytes,modified_ms,favorite,tags_json FROM samples ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY favorite DESC, filename COLLATE NOCASE LIMIT ?`;
    const rows = db.prepare(sql).all(...values, limit).map(toSample);
    return { samples: rows, count: rows.length };
  }

  async getMetadata(input: { id?: number; path?: string }): Promise<unknown> {
    if (input.id === undefined && !input.path) throw new Error("Provide a sample id or exact path.");
    const { db } = await this.setup();
    const row = input.id !== undefined ? db.prepare("SELECT * FROM samples WHERE id = ?").get(input.id) : db.prepare("SELECT * FROM samples WHERE path = ?").get(input.path!);
    if (!row) throw new Error("Sample was not found in the index.");
    return toSample(row as Record<string, unknown>);
  }

  close(): void { this.db?.close(); this.db = undefined; }
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function inferMetadata(path: string): { sampleType: string; bpm: number | null; musicalKey: string | null; kind: "one-shot" | "loop" | "unknown" } {
  const lower = path.toLowerCase();
  const filename = basename(path);
  const types: Array<[string, RegExp]> = [
    ["kick", /(?:^|[/_. -])(kicks?|bd)(?=[/_. -]|$)/], ["clap", /(?:^|[/_. -])claps?(?=[/_. -]|$)/], ["snare", /(?:^|[/_. -])snares?(?=[/_. -]|$)/],
    ["hat", /(?:^|[/_. -])(hats?|hihats?|hi hats?)(?=[/_. -]|$)/], ["percussion", /(?:^|[/_. -])(perc|percussion)(?=[/_. -]|$)/], ["bass", /(?:^|[/_. -])bass(?=[/_. -]|$)/],
    ["vocal", /(?:^|[/_. -])(vocal|vox)(?=[/_. -]|$)/], ["fx", /(?:^|[/_. -])(fx|sfx|effects?)(?=[/_. -]|$)/], ["chord", /(?:^|[/_. -])chords?(?=[/_. -]|$)/],
    ["synth", /(?:^|[/_. -])(synth|lead|pad|arp)(?=[/_. -]|$)/]
  ];
  const sampleType = types.find(([, regex]) => regex.test(lower))?.[0] ?? "other";
  const bpmPattern = /(?:^|[^0-9])((?:[6-9][0-9]|1[0-9]{2}|2[0-4][0-9]))\s*(?:bpm)(?:[^0-9]|$)/i;
  const bareBpmPattern = /(?:^|[/_ -])((?:[6-9][0-9]|1[0-9]{2}|2[0-4][0-9]))(?:[/_ -]|$)/;
  const bpmMatch = bpmPattern.exec(filename) ?? bareBpmPattern.exec(filename) ?? bpmPattern.exec(path) ?? bareBpmPattern.exec(path);
  const keyPattern = /(?:^|[/_. -])([A-Ga-g])([#b]?)(m|min|maj)?(?=[/_. -]|$)/;
  const keyMatch = keyPattern.exec(filename) ?? keyPattern.exec(path);
  const musicalKey = keyMatch ? `${keyMatch[1].toUpperCase()}${keyMatch[2]}${keyMatch[3]?.toLowerCase().startsWith("m") ? "m" : ""}` : null;
  const kind = /\b(loop|loops|beat|beats)\b/.test(lower) ? "loop" : /\b(one[ -]?shot|oneshots?)\b/.test(lower) || ["kick", "clap", "snare", "hat"].includes(sampleType) ? "one-shot" : bpmMatch ? "loop" : "unknown";
  return { sampleType, bpm: bpmMatch ? Number(bpmMatch[1]) : null, musicalKey, kind };
}

async function readWavDuration(path: string): Promise<number | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12; let byteRate: number | null = null; let dataSize: number | null = null;
    while (offset + 8 <= data.length) {
      const id = data.toString("ascii", offset, offset + 4); const size = data.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 20 <= data.length) byteRate = data.readUInt32LE(offset + 16);
      if (id === "data") { dataSize = size; break; }
      offset += 8 + size + (size % 2);
    }
    return byteRate && dataSize !== null ? dataSize / byteRate : null;
  } finally { await handle.close(); }
}

function toSample(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id), path: String(row.path), filename: String(row.filename), extension: String(row.extension),
    folder: String(row.folder), sampleType: String(row.sample_type), bpm: row.bpm === null ? null : Number(row.bpm),
    musicalKey: row.musical_key === null ? null : String(row.musical_key), durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    kind: String(row.kind), sizeBytes: Number(row.size_bytes), modifiedMs: Number(row.modified_ms), favorite: Boolean(row.favorite),
    tags: JSON.parse(String(row.tags_json ?? "[]"))
  };
}
