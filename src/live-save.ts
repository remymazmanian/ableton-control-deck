import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ToolResult } from "./types.js";

const run = promisify(execFile);

// Live's API cannot save, so on macOS this chooses File > Save Live Set in Live's menu bar through
// System Events (Accessibility). It is the only UI automation Control Deck does. The scripts are fixed
// text; nothing from a tool call is put into them.
const DOCUMENT_SCRIPT = `tell application "System Events"
  if not (exists process "Live") then return "NO_LIVE"
  tell process "Live"
    repeat with candidate in windows
      try
        set doc to value of attribute "AXDocument" of candidate
        if doc is not missing value then return doc
      end try
    end repeat
  end tell
end tell
return ""`;
// Live greys out Save Live Set when the set has no unsaved changes.
const UNSAVED_SCRIPT = `tell application "System Events" to tell process "Live" to get enabled of menu item "Save Live Set" of menu "File" of menu bar 1`;
const SAVE_SCRIPT = `tell application "System Events" to tell process "Live" to click menu item "Save Live Set" of menu "File" of menu bar 1`;

export type SaveRunner = (script: string) => Promise<string>;
const osascript: SaveRunner = async script => (await run("osascript", ["-e", script], { timeout: 10_000 })).stdout.trim();

export class LiveSave {
  constructor(private readonly runScript: SaveRunner = osascript, private readonly platform = process.platform) {}

  /** The open set's .als file, or a reason it cannot be known. */
  private async document(): Promise<{ path: string } | { error: ToolResult["error"] }> {
    if (this.platform !== "darwin") return { error: { code: "UNSUPPORTED_PLATFORM", message: "Saving through Control Deck works on macOS only so far. Save in Live with Ctrl+S." } };
    let output: string;
    try {
      output = await this.runScript(DOCUMENT_SCRIPT);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: { code: "ACCESSIBILITY_REQUIRED", message: `macOS would not let Control Deck read Live's window. Allow the app running your agent in System Settings > Privacy & Security > Accessibility. (${message.split("\n")[0]})` } };
    }
    if (output === "NO_LIVE") return { error: { code: "ABLETON_UNAVAILABLE", message: "Ableton Live is not running." } };
    if (!output.startsWith("file:")) return { error: { code: "SET_NEVER_SAVED", message: "This set has not been saved to a file yet. Save it once in Live (File > Save Live Set As), then Control Deck can save it." } };
    return { path: fileURLToPath(output) };
  }

  async projectPath(): Promise<ToolResult> {
    const document = await this.document();
    if ("error" in document) return { ok: false, dryRun: false, tool: "get_project_path", error: document.error };
    return { ok: true, dryRun: false, tool: "get_project_path", data: { path: document.path } };
  }

  private async hasUnsavedChanges(): Promise<boolean> {
    return (await this.runScript(UNSAVED_SCRIPT)) === "true";
  }

  async unsavedStatus(): Promise<ToolResult> {
    const tool = "get_unsaved_status";
    const document = await this.document();
    if ("error" in document && document.error?.code !== "SET_NEVER_SAVED") return { ok: false, dryRun: false, tool, error: document.error };
    const unsaved = await this.hasUnsavedChanges();
    return { ok: true, dryRun: false, tool, data: { path: "path" in document ? document.path : null, unsavedChanges: unsaved } };
  }

  /** Saves the open set in place and confirms the file on disk changed. A set with no changes is already saved. */
  async save(dryRun = false): Promise<ToolResult> {
    const tool = "save_live_set";
    const document = await this.document();
    if ("error" in document) return { ok: false, dryRun, tool, error: document.error };
    if (!(await this.hasUnsavedChanges())) return { ok: true, dryRun, tool, data: { path: document.path, saved: false, upToDate: true } };
    const before = (await stat(document.path)).mtimeMs;
    if (dryRun) return { ok: true, dryRun: true, tool, data: { path: document.path }, intendedOperations: [{ address: "ui://Live/File/Save Live Set", args: [document.path] }] };
    try {
      await this.runScript(SAVE_SCRIPT);
    } catch (error) {
      return { ok: false, dryRun, tool, error: { code: "SAVE_FAILED", message: `Live's Save Live Set menu item could not be chosen: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` } };
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const after = (await stat(document.path).catch(() => null))?.mtimeMs;
      if (after !== undefined && after > before) return { ok: true, dryRun, tool, data: { path: document.path, saved: true, savedAt: new Date(after).toISOString() } };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { ok: false, dryRun, tool, error: { code: "SAVE_NOT_VERIFIED", message: `Chose Save Live Set, but ${document.path} did not change within 10 seconds. Check Live for a dialog.` } };
  }
}
