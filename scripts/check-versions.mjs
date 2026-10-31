#!/usr/bin/env node
// Fails when a version that cannot import package.json disagrees with it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const problems = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function expectEqual(label, actual) {
  if (actual !== expected) problems.push(`${label} is ${actual ?? "missing"}, package.json is ${expected}`);
}

function expectPattern(label, path, pattern) {
  const match = read(path).match(pattern);
  expectEqual(label, match?.[1]);
}

function expectLockfile(path) {
  const lock = JSON.parse(read(path));
  expectEqual(`${path} version`, lock.version);
  expectEqual(`${path} root package version`, lock.packages?.[""]?.version);
}

if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/.test(expected)) {
  problems.push(`package.json version must be a simple major.minor.patch, found ${expected}`);
}

expectLockfile("package-lock.json");
expectLockfile("dashboard/package-lock.json");
expectEqual("dashboard/package.json version", JSON.parse(read("dashboard/package.json")).version);
expectPattern("remote script SCRIPT_VERSION", "remote-script/Control_Deck/Control_Deck.py", /^SCRIPT_VERSION = "([^"]+)"/m);
expectPattern("macOS short version", "macos/Info.plist", /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
expectPattern("HELP log example", "HELP.md", /\(Control Deck Bridge\) (\d+\.\d+\.\d+) listening/);

if (problems.length) {
  console.error("Version check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Versions match package.json (${expected}).`);
