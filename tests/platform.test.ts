import { describe, expect, it } from "vitest";
import { isExternalDrive } from "../src/external-drive.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineTokenPath } from "../src/machine-token.js";
import { dataRootFor } from "../src/paths.js";
// @ts-expect-error -- plain JavaScript module shared with setup
import * as platform from "../src/platform.mjs";

describe("platform helpers", () => {
  it("reads the User Library folder from Live's Library.cfg", () => {
    const windows = `<Ableton><ContentLibrary/><UserLibrary>\n<ProjectPath Value="C:/Users/remym/OneDrive/Documents/Ableton" />\n</UserLibrary></Ableton>`;
    expect(platform.parseLibraryCfg(windows)).toBe("C:/Users/remym/OneDrive/Documents/Ableton");
    expect(platform.parseLibraryCfg(`<UserLibrary><ProjectPath Value="/Users/remy/Music/Ableton" /></UserLibrary>`)).toBe("/Users/remy/Music/Ableton");
    expect(platform.parseLibraryCfg("<Ableton/>")).toBeNull();
  });

  it("decides the same external drives in both copies of the rule", () => {
    const cases: Array<[string, NodeJS.Platform, boolean]> = [
      ["/Volumes/Samples/Kicks", "darwin", true], ["/Users/remy/Samples", "darwin", false],
      ["D:\\Samples", "win32", true], ["d:/Samples", "win32", true], ["C:\\Users\\remym\\Samples", "win32", false], ["\\\\server\\share", "win32", false]
    ];
    for (const [path, os, expected] of cases) {
      expect(isExternalDrive(path, { SystemDrive: "C:" }, os)).toBe(expected);
      expect(platform.isExternalDrive(path, { SystemDrive: "C:" }, os)).toBe(expected);
    }
  });

  it("keeps the secret in the same per-machine place in both copies, never in Live's library", () => {
    for (const [os, env, home] of [["darwin", {}, "/Users/remy"], ["win32", { LOCALAPPDATA: "C:\\Users\\remym\\AppData\\Local" }, "C:\\Users\\remym"]] as const) {
      const fromTs = machineTokenPath(home, env, os);
      expect(platform.machineTokenPath(home, env, os)).toBe(fromTs);
      expect(fromTs).toMatch(/Ableton Control Deck[\\/]bridge-token$/);
      expect(fromTs).not.toMatch(/User Library|OneDrive|Documents/);
    }
  });

  it("spots Downloads and Desktop, including with Windows separators", () => {
    expect(platform.inTemporaryFolder("/Users/remy/Downloads/ableton-control-deck")).toBe("Downloads");
    expect(platform.inTemporaryFolder("C:\\Users\\remym\\OneDrive\\Desktop\\ableton-control-deck")).toBe("Desktop");
    expect(platform.inTemporaryFolder("C:\\Users\\remym\\Code\\ableton-control-deck")).toBeNull();
  });

  it("keeps a checkout's data in place and a packaged install's data per machine", () => {
    const root = mkdtempSync(join(tmpdir(), "control-deck-root-"));
    try {
      const env = {};
      expect(dataRootFor(root, "/Users/remy", env, "darwin")).toBe(root);
      expect(platform.dataRoot(root, "/Users/remy", env, "darwin")).toBe(root);
      writeFileSync(join(root, "packaged.json"), "{}");
      expect(dataRootFor(root, "/Users/remy", env, "darwin")).toBe("/Users/remy/Library/Application Support/Ableton Control Deck");
      expect(platform.dataRoot(root, "/Users/remy", env, "darwin")).toBe(dataRootFor(root, "/Users/remy", env, "darwin"));
      const override = { CONTROL_DECK_DATA: join(root, "elsewhere") };
      expect(dataRootFor(root, "/Users/remy", override, "darwin")).toBe(join(root, "elsewhere"));
      expect(platform.dataRoot(root, "/Users/remy", override, "darwin")).toBe(join(root, "elsewhere"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
