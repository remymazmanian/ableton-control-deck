#!/usr/bin/env node
// Full local setup for Ableton Control Deck. Safe to re-run at any time.
//
//   npm run setup                     everything: deps, builds, token,
//                                     remote script, launch agents, activation
//   npm run setup -- --skip-build     skip npm installs and builds (dev loop)
//   npm run setup -- --skip-remote-script
//   npm run setup -- --skip-agents    do not write or start the background services
//
// Works on macOS (launch agents) and Windows (Task Scheduler). The installers
// run this same script, so keep every message understandable without a
// coding background.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inTemporaryFolder, isWindows, machineTokenPath, remoteScriptsPath } from "../src/platform.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const args = new Set(process.argv.slice(2));
const home = homedir();
const skipBuild = args.has("--skip-build");

// Before 1.5 the secret lived in data/bridge-token and was written into the remote script. It now
// lives in a per-machine file outside any synced folder; an existing secret is moved there unchanged.
const legacyTokenFile = path.join(root, "data", "bridge-token");
const tokenFile = machineTokenPath();
const installPathFile = path.join(root, "data", "install-path");
const remoteScriptSource = path.join(root, "remote-script", "Control_Deck");
const remoteScriptTarget = remoteScriptsPath();
const remoteScriptTargetDirectory = remoteScriptTarget.path;
const sampleLibraryConfig = path.join(root, "config", "sample-library.json");
const sampleLibraryExample = path.join(root, "config", "sample-library.example.json");
const agentsDirectory = path.join(home, "Library", "LaunchAgents");
const nodePath = process.execPath;

let failures = 0;

function ok(message) { console.log(`  ✓ ${message}`); }
function warn(message) { console.log(`  ⚠ ${message}`); }
function fail(message) { failures += 1; console.log(`  ✗ ${message}`); }
function heading(message) { console.log(`\n${message}`); }

function run(command, commandArguments, { cwd = root, quiet = false } = {}) {
  // On Windows npm is npm.cmd, which Node only runs through a shell.
  const viaShell = isWindows && command === "npm";
  const result = spawnSync(command, commandArguments, {
    cwd,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
    shell: viaShell,
    windowsHide: true,
  });
  return result;
}

heading("Ableton Control Deck setup");
console.log(`  Install location: ${root}`);

// ---------------------------------------------------------------- guardrails
const temporaryFolder = inTemporaryFolder(root);
if (temporaryFolder && !args.has("--allow-any-location")) {
  console.log(`
  This folder is in your ${temporaryFolder} folder. Setup pins services to the
  folder's location, so please move it somewhere permanent first — your home
  folder works well. Then run the installer again from the new location.
`);
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.log(`
  This app needs Node.js 20 or newer; you have ${process.versions.node}.
  Download the LTS installer from https://nodejs.org and run setup again.
`);
  process.exit(1);
}
ok(`Node.js ${process.versions.node}`);

let previousPath = null;
try {
  previousPath = (await readFile(installPathFile, "utf8")).trim();
} catch {}
if (previousPath && previousPath !== root) {
  warn(`The folder moved since the last setup (was ${previousPath}). Refreshing everything for the new location.`);
}

// ------------------------------------------------------------ deps + builds
if (!skipBuild) {
  heading("Installing and building (first run can take a few minutes)");

  const rootInstall = run("npm", ["install", "--no-fund", "--no-audit"], { quiet: true });
  if (rootInstall.status === 0) ok("Bridge dependencies installed");
  else {
    fail("npm install failed in the project folder");
    console.log(rootInstall.stderr || rootInstall.stdout);
  }

  const serverBuild = run("npm", ["run", "build"], { quiet: true });
  if (serverBuild.status === 0) ok("MCP server built");
  else {
    fail("Could not build the MCP server");
    console.log(serverBuild.stderr || serverBuild.stdout);
  }

  const omnihostBuild = run("node", [path.join(root, "max-for-live", "build-device.mjs")], { quiet: true });
  if (omnihostBuild.status === 0) ok("OmniHost Max for Live device built");
  else {
    fail("Could not build the OmniHost device");
    console.log(omnihostBuild.stderr || omnihostBuild.stdout);
  }

  const dashboardInstall = run("npm", ["install", "--no-fund", "--no-audit"], { cwd: path.join(root, "dashboard"), quiet: true });
  if (dashboardInstall.status === 0) ok("Dashboard dependencies installed");
  else {
    fail("npm install failed in dashboard/");
    console.log(dashboardInstall.stderr || dashboardInstall.stdout);
  }

  const dashboardBuild = run("npm", ["run", "build"], { cwd: path.join(root, "dashboard"), quiet: true });
  if (dashboardBuild.status === 0) ok("Dashboard built");
  else {
    fail("Dashboard build failed");
    console.log(dashboardBuild.stderr || dashboardBuild.stdout);
  }
}

// ------------------------------------------------------------------- secret
heading("Bridge secret");
await mkdir(path.dirname(tokenFile), { recursive: true });
if (existsSync(tokenFile)) {
  ok("Using this computer's bridge secret");
} else if (existsSync(legacyTokenFile)) {
  await writeFile(tokenFile, `${(await readFile(legacyTokenFile, "utf8")).trim()}\n`, { mode: 0o600 });
  ok(`Moved the bridge secret to ${tokenFile}`);
} else {
  await writeFile(tokenFile, `${randomUUID()}\n`, { mode: 0o600 });
  ok(`Generated a new bridge secret (${tokenFile})`);
}

// ------------------------------------------------------------ sample config
if (!existsSync(sampleLibraryConfig) && existsSync(sampleLibraryExample)) {
  await copyFile(sampleLibraryExample, sampleLibraryConfig);
  ok("Created config/sample-library.json (edit it to point at your sample drive before indexing)");
} else if (existsSync(sampleLibraryConfig)) {
  ok("Sample library config already present");
}

// ------------------------------------------------------------ remote script
if (!args.has("--skip-remote-script")) {
  heading("Ableton Live remote script");
  // The script reads the secret from this computer's secret file, so the copy in Live's User Library
  // holds no secret and is safe in a synced folder.
  const entries = await readdir(remoteScriptSource);
  const pythonFiles = entries.filter(entry => entry.endsWith(".py"));
  await mkdir(remoteScriptTargetDirectory, { recursive: true });
  for (const file of pythonFiles) {
    await copyFile(path.join(remoteScriptSource, file), path.join(remoteScriptTargetDirectory, file));
  }
  ok(`Installed to ${remoteScriptTargetDirectory} (found from ${remoteScriptTarget.source})`);
}

// ------------------------------------------------------------ launch agents
function plist(label, programArguments, { workingDirectory } = {}) {
  const argumentStrings = programArguments.map(value => `    <string>${value}</string>`).join("\n");
  const workingDirectoryEntry = workingDirectory
    ? `  <key>WorkingDirectory</key>\n  <string>${workingDirectory}</string>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argumentStrings}
  </array>
${workingDirectoryEntry}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.error.log</string>
</dict>
</plist>
`;
}

// Windows: one Task Scheduler task per service, started at sign-in and restarted if it stops. It runs
// "whether the user is signed in or not" (S4U): no window, no stored password, the user's own account
// and files, and Task Scheduler stays its parent so stopping the task stops the service. Accounts whose
// policy does not allow that fall back to a windowless conhost launch, which Task Scheduler cannot watch.
function taskName(label) {
  return label === "com.abletondeck.api" ? "Ableton Control Deck API" : "Ableton Control Deck Dashboard";
}

function registerWindowsTask(agent) {
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const [executable, ...rest] = agent.programArguments;
  const argumentLine = rest.map(value => `"${value}"`).join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${quote(taskName(agent.label))}`,
    "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false }",
    // Stop this service's Node from an earlier install (including one Task Scheduler lost track of) and wait
    // for it to exit, so the new task does not find the port still taken.
    `$entry = ${quote(rest[0])}`,
    "$old = { @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }) }",
    "& $old | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "for ($i = 0; $i -lt 40 -and (& $old).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    `$direct = New-ScheduledTaskAction -Execute ${quote(executable)} -Argument ${quote(argumentLine)} -WorkingDirectory ${quote(agent.workingDirectory)}`,
    "$mode = 'S4U'",
    "try { Register-ScheduledTask -TaskName $name -Description 'Ableton Control Deck background service' -Action $direct -Trigger $trigger -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited) | Out-Null } " +
      `catch { $mode = 'conhost'; $hidden = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${quote(`--headless "${executable}" ${argumentLine}`)} -WorkingDirectory ${quote(agent.workingDirectory)}; Register-ScheduledTask -TaskName $name -Description 'Ableton Control Deck background service' -Action $hidden -Trigger $trigger -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited) | Out-Null }`,
    "Start-ScheduledTask -TaskName $name",
    "Write-Output $mode",
  ].join("; ");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { quiet: true });
}

if (!args.has("--skip-agents")) {
  heading("Background services");
  const agents = [
    {
      label: "com.abletondeck.api",
      available: true,
      programArguments: [nodePath, path.join(root, "src", "dashboard-server.mjs")],
      workingDirectory: root,
    },
    {
      label: "com.abletondeck.dashboard",
      available: existsSync(path.join(root, "dashboard", "node_modules", "next")),
      hint: "dashboard is not built yet",
      programArguments: [
        nodePath,
        path.join(root, "dashboard", "node_modules", "next", "dist", "bin", "next"),
        "start",
        "--port", "50713",
        "--hostname", "127.0.0.1",
      ],
      workingDirectory: path.join(root, "dashboard"),
    },
  ];

  if (isWindows) {
    for (const agent of agents) {
      if (!agent.available) { warn(`Skipped ${agent.label} (${agent.hint}).`); continue; }
      const result = registerWindowsTask(agent);
      if (result.status === 0 && result.stdout.trim().endsWith("conhost")) warn(`${taskName(agent.label)} is running, but this account cannot run background tasks, so Windows will not restart it if it stops. Run setup again after it stops.`);
      else if (result.status === 0) ok(`${taskName(agent.label)} is running (starts automatically when you sign in)`);
      else { fail(`Could not start ${taskName(agent.label)}`); console.log(result.stderr || result.stdout); }
    }
  } else {
    await mkdir(agentsDirectory, { recursive: true });
    const uid = process.getuid();
    for (const agent of agents) {
      if (!agent.available) {
        warn(`Skipped ${agent.label} (${agent.hint}).`);
        continue;
      }
      const target = path.join(agentsDirectory, `${agent.label}.plist`);
      await writeFile(target, plist(agent.label, agent.programArguments, agent));
      // Re-running setup must restart services cleanly. bootout is asynchronous —
      // the label lingers until the process exits — so wait for it to disappear
      // and give bootstrap a few attempts before declaring failure.
      run("launchctl", ["bootout", `gui/${uid}/${agent.label}`], { quiet: true });
      let bootstrap = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const lingering = run("launchctl", ["print", `gui/${uid}/${agent.label}`], { quiet: true });
        if (lingering.status !== 0) {
          bootstrap = run("launchctl", ["bootstrap", `gui/${uid}`, target], { quiet: true });
          if (bootstrap.status === 0) break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (bootstrap?.status === 0) ok(`${agent.label} is running (starts automatically at login)`);
      else {
        fail(`Could not start ${agent.label}`);
        if (bootstrap) console.log(bootstrap.stderr || bootstrap.stdout);
      }
    }
  }
}

await mkdir(path.dirname(installPathFile), { recursive: true });
await writeFile(installPathFile, `${root}\n`);

// ------------------------------------------------------------------ summary
if (failures > 0) {
  heading(`Setup finished with ${failures} problem${failures === 1 ? "" : "s"} — see the ✗ lines above.`);
  console.log("  Fix the issue, then run setup again; it is always safe to re-run.\n");
  process.exit(1);
}

heading("Setup complete. Two steps left:");
console.log(`
  1. Open Live → ${isWindows ? "Options → Preferences" : "Settings"} → Link, Tempo & MIDI and pick “Control Deck” as a
     Control Surface (restart Live first if it was open during setup).
  2. Connect your SI agent: open http://127.0.0.1:50713/connect for
     copy-paste instructions for Claude Code, Codex, and every other client.
`);
