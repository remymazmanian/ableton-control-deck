/**
 * Whether a path is on a drive other than the system's: under /Volumes on macOS, or a drive letter other
 * than the system drive on Windows. The same rule as isExternalDrive in platform.mjs (which setup uses
 * before anything is built); tests/platform.test.ts checks the two agree.
 */
export function isExternalDrive(target: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const value = String(target);
  if (platform === "win32") {
    const drive = /^([A-Za-z]):[\\/]/.exec(value);
    const system = (env.SystemDrive || "C:").replace(/[\\/]+$/, "").toUpperCase();
    return !!drive && `${drive[1].toUpperCase()}:` !== system;
  }
  return value.startsWith("/Volumes/");
}
