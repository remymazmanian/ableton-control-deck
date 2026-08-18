import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = basename(dirname(moduleDirectory)) === "dist"
  ? resolve(moduleDirectory, "../..")
  : resolve(moduleDirectory, "..");

export const fromProjectRoot = (path: string): string => resolve(projectRoot, path);
