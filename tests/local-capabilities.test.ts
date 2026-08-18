import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LocalCapabilities, nextVersionedFilename } from "../src/local-capabilities.js";

describe("local capability boundaries", () => {
  it("generates a collision-safe next version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ableton-versions-"));
    await writeFile(join(directory, "Night Drive - v001.als"), "");
    await writeFile(join(directory, "Night Drive - v003.als"), "");
    expect(await nextVersionedFilename(directory, "Night Drive.als")).toBe(join(directory, "Night Drive - v004.als"));
  });

  it("returns an explicit unsupported save error", () => {
    expect(new LocalCapabilities().save("save_live_set")).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CAPABILITY" } });
  });
});
