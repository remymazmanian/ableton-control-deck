import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ToolResult } from "./types.js";
import { fromProjectRoot } from "./paths.js";

type TemplateCategory = "trackTemplates" | "instrumentRacks" | "audioEffectRacks" | "drumRacks" | "defaultProjectTemplates" | "favoriteSerumPresets" | "favoriteDeviceChains";
const CATEGORIES: TemplateCategory[] = ["trackTemplates", "instrumentRacks", "audioEffectRacks", "drumRacks", "defaultProjectTemplates", "favoriteSerumPresets", "favoriteDeviceChains"];

export class LocalCapabilities {
  constructor(private readonly templatesPath = fromProjectRoot("config/templates.json")) {}

  async listTemplates(category?: TemplateCategory): Promise<ToolResult> {
    if (category && !CATEGORIES.includes(category)) throw new Error(`Unknown template category: ${category}`);
    const config = JSON.parse(await readFile(this.templatesPath, "utf8")) as Record<TemplateCategory, string[]>;
    const categories = category ? [category] : CATEGORIES;
    const data: Record<string, unknown[]> = {};
    for (const key of categories) {
      data[key] = await Promise.all((config[key] ?? []).map(async (path, index) => ({ index, name: basename(path), path, extension: extname(path), readable: await isReadable(path) })));
    }
    return { ok: true, dryRun: false, tool: "list_templates", data: { categories: data } };
  }

  unsupportedLoad(tool: string, kind: string): ToolResult {
    return unsupported(tool, `The current bridge API does not yet load ${kind}. Add it to config/templates.json for discovery, then load it manually in Live.`);
  }

  getProjectPath(): ToolResult {
    return unsupported("get_project_path", "The current bridge API does not expose the current Live Set document path.");
  }

  save(tool: "save_live_set" | "save_live_set_as"): ToolResult {
    return unsupported(tool, "The current bridge API does not expose Live Set save or save-as. UI automation is intentionally disabled, so no save was attempted.");
  }

  async createProjectVersion(input: { projectDirectory?: string; projectName?: string; overwrite?: boolean }): Promise<ToolResult> {
    if (input.overwrite) return unsupported("create_project_version", "Version overwrite is not available because the current bridge API cannot perform save-as.");
    let proposedFilename: string | undefined;
    if (input.projectDirectory && input.projectName) proposedFilename = await nextVersionedFilename(input.projectDirectory, input.projectName);
    const result = unsupported("create_project_version", "A collision-safe filename can be proposed, but the current bridge API cannot execute Live's Save As command. No file was written.");
    result.data = { proposedFilename };
    return result;
  }

  getUnsavedStatus(): ToolResult {
    return unsupported("get_unsaved_status", "The current bridge API does not expose Live's modified/unsaved state.");
  }
}

export async function nextVersionedFilename(directory: string, projectName: string): Promise<string> {
  if (!projectName.trim()) throw new Error("Project name must not be empty.");
  const cleanName = projectName.replace(/\s+-\s+v\d+$/i, "").replace(/\.als$/i, "").trim();
  let entries: string[] = [];
  try { entries = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped} - v(\\d{3})\\.als$`, "i");
  const highest = entries.reduce((max, name) => Math.max(max, Number(regex.exec(name)?.[1] ?? 0)), 0);
  return join(directory, `${cleanName} - v${String(highest + 1).padStart(3, "0")}.als`);
}

function unsupported(tool: string, message: string): ToolResult {
  return { ok: false, dryRun: false, tool, error: { code: "UNSUPPORTED_CAPABILITY", message } };
}

async function isReadable(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}
