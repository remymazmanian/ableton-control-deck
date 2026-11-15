// Platform details for macOS and Windows: where Live keeps its User Library, where plug-ins live,
// and which drives count as external. Plain JavaScript so setup can use it before anything is built.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Read the User Library's parent folder from the text of Live's Library.cfg. */
export function parseLibraryCfg(text) {
  const block = /<UserLibrary>([\s\S]*?)<\/UserLibrary>/.exec(String(text));
  const match = block && /<ProjectPath\s+Value="([^"]+)"/.exec(block[1]);
  return match ? match[1] : null;
}

function preferenceFolders(home = homedir(), env = process.env) {
  if (isWindows) return env.APPDATA ? [path.join(env.APPDATA, "Ableton")] : [];
  return [path.join(home, "Library", "Preferences", "Ableton")];
}

/** Library.cfg files from every installed Live version, newest first by when Live last wrote them. */
export function libraryConfigs(home = homedir(), env = process.env) {
  const configs = [];
  for (const folder of preferenceFolders(home, env)) {
    let versions = [];
    try { versions = readdirSync(folder).filter(name => /^Live \d/.test(name)); } catch { continue; }
    for (const version of versions) {
      const file = isWindows ? path.join(folder, version, "Preferences", "Library.cfg") : path.join(folder, version, "Library.cfg");
      try { configs.push({ file, version, modified: statSync(file).mtimeMs }); } catch { /* no config for this version */ }
    }
  }
  return configs.sort((a, b) => b.modified - a.modified);
}

/**
 * Live's User Library folder. Live keeps it under the folder named in Library.cfg, which may have been
 * moved (and on Windows, Documents is often redirected to OneDrive), so read the newest config first.
 */
export function userLibraryPath(home = homedir(), env = process.env) {
  for (const config of libraryConfigs(home, env)) {
    try {
      const parent = parseLibraryCfg(readFileSync(config.file, "utf8"));
      if (parent) return { path: path.join(path.normalize(parent), "User Library"), source: `Live ${config.version.replace(/^Live /, "")} settings` };
    } catch { /* unreadable; try the next */ }
  }
  const documents = isWindows ? path.join(env.USERPROFILE || home, "Documents") : path.join(home, "Music");
  return { path: path.join(documents, "Ableton", "User Library"), source: "default location" };
}

export function remoteScriptsPath(home = homedir(), env = process.env) {
  const library = userLibraryPath(home, env);
  return { path: path.join(library.path, "Remote Scripts", "Control_Deck"), source: library.source };
}

/** Folders scanned for plug-ins, with their format and whether they are system-wide or per-user. */
export function pluginFolders(home = homedir(), env = process.env) {
  if (isWindows) {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const common = env.CommonProgramFiles || path.join(programFiles, "Common Files");
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      { path: path.join(common, "VST3"), format: "VST3", location: "System" },
      { path: path.join(common, "CLAP"), format: "CLAP", location: "System" },
      { path: path.join(common, "VST2"), format: "VST2", location: "System" },
      { path: path.join(programFiles, "VSTPlugins"), format: "VST2", location: "System" },
      { path: path.join(programFiles, "Steinberg", "VSTPlugins"), format: "VST2", location: "System" },
      { path: path.join(local, "Programs", "Common", "VST3"), format: "VST3", location: "User" },
      { path: path.join(local, "Programs", "Common", "CLAP"), format: "CLAP", location: "User" }
    ];
  }
  return [
    { path: "/Library/Audio/Plug-Ins/VST", format: "VST2", location: "System" },
    { path: "/Library/Audio/Plug-Ins/VST3", format: "VST3", location: "System" },
    { path: "/Library/Audio/Plug-Ins/Components", format: "AU", location: "System" },
    { path: "/Library/Audio/Plug-Ins/CLAP", format: "CLAP", location: "System" },
    { path: path.join(home, "Library/Audio/Plug-Ins/VST"), format: "VST2", location: "User" },
    { path: path.join(home, "Library/Audio/Plug-Ins/VST3"), format: "VST3", location: "User" },
    { path: path.join(home, "Library/Audio/Plug-Ins/Components"), format: "AU", location: "User" },
    { path: path.join(home, "Library/Audio/Plug-Ins/CLAP"), format: "CLAP", location: "User" }
  ];
}

/**
 * Whether a path is on a drive other than the system's: under /Volumes on macOS, or a drive letter
 * other than the system drive on Windows. Sample libraries are expected to live on such a drive.
 */
export function isExternalDrive(target, env = process.env, platform = process.platform) {
  const value = String(target);
  if (platform === "win32") {
    const drive = /^([A-Za-z]):[\\/]/.exec(value);
    const system = (env.SystemDrive || "C:").replace(/[\\/]+$/, "").toUpperCase();
    return !!drive && `${drive[1].toUpperCase()}:` !== system;
  }
  return value.startsWith("/Volumes/");
}

/** True when the folder sits in Downloads or Desktop (including OneDrive's), which setup should not pin services to. */
export function inTemporaryFolder(folder) {
  const normal = `${String(folder).replace(/\\/g, "/")}/`.toLowerCase();
  return /\/(downloads|desktop)\//.test(normal) ? (normal.includes("/downloads/") ? "Downloads" : "Desktop") : null;
}

/**
 * Where this machine keeps the bridge secret: Application Support on macOS, %LOCALAPPDATA% on Windows.
 * It stays out of Live's User Library, which people often sync with OneDrive, iCloud, or Dropbox: two
 * machines sharing one secret file would lock each other out, and the secret would sit in the cloud.
 */
export function machineTokenPath(home = homedir(), env = process.env, platform = process.platform) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || home, "AppData", "Local"), "Ableton Control Deck", "bridge-token");
  return path.join(home, "Library", "Application Support", "Ableton Control Deck", "bridge-token");
}
