import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

const { version } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };

const nextConfig: NextConfig = {
  env: {
    CONTROL_DECK_VERSION: version,
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
