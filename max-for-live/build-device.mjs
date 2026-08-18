import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "Control Deck OmniHost.maxpat");
const controller = join(here, "omnihost-controller.js");
const outputDirectory = join(here, "build");
const output = join(outputDirectory, "Control Deck OmniHost.amxd");

const patch = await readFile(source);
JSON.parse(patch.toString("utf8"));

const uint32 = value => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};

const amxd = Buffer.concat([
  Buffer.from("ampf", "ascii"),
  uint32(4),
  Buffer.from("iiii", "ascii"),
  Buffer.from("meta", "ascii"),
  uint32(4),
  Buffer.alloc(4),
  Buffer.from("ptch", "ascii"),
  uint32(patch.length),
  patch
]);

await mkdir(outputDirectory, { recursive: true });
await writeFile(output, amxd);
await copyFile(controller, join(outputDirectory, "omnihost-controller.js"));
process.stdout.write(`${output}\n`);

