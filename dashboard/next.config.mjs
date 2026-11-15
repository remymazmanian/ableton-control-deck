// Plain JavaScript so `next start` does not need a compiler to read it: the installers ship the dashboard
// without Next.js's build-time native compiler.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));

/** @type {import("next").NextConfig} */
const nextConfig = {
  env: {
    CONTROL_DECK_VERSION: version,
  },
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
