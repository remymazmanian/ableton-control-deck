import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LiveSave } from "../src/live-save.js";

async function setFile() {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "live-save-")), "Song.als");
  await writeFile(file, "set");
  await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  return file;
}

describe("save_live_set", () => {
  it("chooses Save Live Set and confirms the file changed", async () => {
    const file = await setFile();
    const scripts: string[] = [];
    const save = new LiveSave(async script => {
      scripts.push(script);
      if (script.includes("AXDocument")) return pathToFileURL(file).href;
      await writeFile(file, "saved");
      return "";
    }, "darwin");
    expect(await save.save()).toMatchObject({ ok: true, data: { path: file } });
    expect(scripts[1]).toContain('menu item "Save Live Set"');
  });

  it("refuses a set that was never saved, without touching the menu", async () => {
    const scripts: string[] = [];
    const save = new LiveSave(async script => { scripts.push(script); return ""; }, "darwin");
    expect(await save.save()).toMatchObject({ ok: false, error: { code: "SET_NEVER_SAVED" } });
    expect(scripts).toHaveLength(1);
  });

  it("explains a missing Accessibility permission and other platforms", async () => {
    const denied = new LiveSave(async () => { throw new Error("not allowed assistive access"); }, "darwin");
    expect(await denied.save()).toMatchObject({ ok: false, error: { code: "ACCESSIBILITY_REQUIRED" } });
    expect(await new LiveSave(async () => "", "win32").save()).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PLATFORM" } });
  });

  it("reports the set's path", async () => {
    const file = await setFile();
    expect(await new LiveSave(async () => pathToFileURL(file).href, "darwin").projectPath()).toMatchObject({ ok: true, data: { path: file } });
  });
});
