#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg?.slice("--mode=".length) || "noop";
const filePath = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]);

if (!filePath) {
  process.stderr.write("fake-formatter: missing file path\n");
  process.exit(2);
}

const input = await readFile(filePath, "utf8");
let output = input;

switch (mode) {
  case "noop":
    break;
  case "top-comment":
    output = `// formatted\n${input.replace(/^\/\/ formatted\n/, "")}`;
    break;
  case "trim-trailing":
    output = input.replace(/[ \t]+$/gm, "");
    break;
  default:
    process.stderr.write(`fake-formatter: unknown mode ${mode}\n`);
    process.exit(2);
}

if (output !== input) {
  await writeFile(filePath, output, "utf8");
}
