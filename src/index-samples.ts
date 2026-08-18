#!/usr/bin/env node
import { SampleIndex } from "./sample-index.js";

const args = new Set(process.argv.slice(2));
const index = new SampleIndex();
try {
  const result = await index.refresh({ rebuild: args.has("--rebuild"), confirm: args.has("--confirm") });
  console.log(JSON.stringify(result, null, 2));
} finally { index.close(); }
