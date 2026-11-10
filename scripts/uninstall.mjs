#!/usr/bin/env node
// Removes what setup put outside this folder: the background services, the remote script and the
// OmniHost device in Live's User Library, and this computer's Control Deck data. The macOS and Windows
// uninstallers run this first, then delete the program files themselves.
//
//   npm run uninstall                    asks whether to keep settings and snapshots
//   node scripts/uninstall.mjs --keep-data | --remove-data
//
// --keep-data keeps settings (config/), indexes, and snapshots (data/); the bridge secret and logs go.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dataRoot, isWindows, machineTokenPath, remoteScriptsPath, userLibraryPath } from "../src/platform.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const args = new Set(process.argv.slice(2));
const packaged = existsSync(path.join(root, "packaged.json"));
const machineFolder = path.dirname(machineTokenPath());
const labels = ["com.abletondeck.api", "com.abletondeck.dashboard"];
const taskNames = ["Ableton Control Deck API", "Ableton Control Deck Dashboard"];

let problems = 0;
const ok = message => console.log(`  ✓ ${message}`);
const fail = message => { problems += 1; console.log(`  ✗ ${message}`); };
const run = (command, commandArguments) => spawnSync(command, commandArguments, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

async function keepData() {
  if (args.has("--keep-data")) return true;
  if (args.has("--remove-data")) return false;
  if (!process.stdin.isTTY) return true;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("  Keep settings and snapshots? [Y/n] ")).trim().toLowerCase();
  prompt.close();
  return answer !== "n" && answer !== "no";
}

async function remove(target, label) {
  if (!existsSync(target)) return;
  try {
    await rm(target, { recursive: true, force: true });
    ok(`Removed ${label}`);
  } catch (error) {
    fail(`Could not remove ${label} (${error.message})`);
  }
}

console.log("\nAbleton Control Deck uninstall");
const keep = await keepData();

// ---------------------------------------------------------------- services
if (isWindows) {
  const quoted = taskNames.map(name => `'${name}'`).join(",");
  const script = [
    `foreach ($name in @(${quoted})) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false } }`,
    `$root = '${root.replace(/'/g, "''")}'`,
    // Every other Node running from this folder (an agent's MCP server, a stray service), but not this one.
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ].join("; ");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
  if (result.status === 0) ok("Stopped and removed the background services");
  else fail(`Could not remove the background services: ${result.stderr || result.stdout}`);
} else {
  const uid = process.getuid();
  for (const label of labels) {
    run("launchctl", ["bootout", `gui/${uid}/${label}`]);
    await remove(path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`), `${label}`);
  }
}

// ------------------------------------------------------- Live User Library
const scriptFolder = remoteScriptsPath().path;
if (existsSync(path.join(scriptFolder, "Control_Deck.py"))) await remove(scriptFolder, `the remote script (${scriptFolder})`);

const omnihostFolder = path.join(userLibraryPath().path, "Presets", "Instruments", "Max Instrument", "Control Deck");
for (const file of ["Control Deck OmniHost.amxd", "omnihost-controller.js"]) await remove(path.join(omnihostFolder, file), file);
try {
  if (existsSync(omnihostFolder) && (await readdir(omnihostFolder)).length === 0) await rmdir(omnihostFolder);
} catch { /* leave a folder that still holds the user's own files */ }

// --------------------------------------------------------------------- data
await remove(machineTokenPath(), "the bridge secret");
if (packaged) {
  const data = dataRoot(root);
  if (keep) {
    await remove(path.join(data, "logs"), "logs");
    console.log(`  Kept settings and snapshots in ${data}`);
  } else {
    await remove(data, `settings, indexes, and snapshots (${data})`);
  }
} else {
  console.log(`  This checkout keeps its own config/ and data/ in ${root}; delete the folder to remove them.`);
}
if (!keep) {
  try {
    if (existsSync(machineFolder) && (await readdir(machineFolder)).length === 0) await rmdir(machineFolder);
  } catch { /* not empty */ }
}

console.log(problems ? `\nFinished with ${problems} problem${problems === 1 ? "" : "s"}.` : "\nDone. To disconnect an agent, remove its \"ableton\" MCP server (Claude Code: claude mcp remove ableton).");
process.exit(problems ? 1 : 0);
