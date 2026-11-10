import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("version sync", () => {
  it("accepts the tree when every pinned version matches package.json", () => {
    const result = execFileSync(process.execPath, ["scripts/check-versions.mjs"], { encoding: "utf8" });
    expect(result).toMatch(/Versions match package\.json/);
  });
});
