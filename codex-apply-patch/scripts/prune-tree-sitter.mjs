import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This extension runs on one Linux x64 machine. Keep native tree-sitter lean so
// Pi reloads don't crawl through platform builds and grammar sources we never use.

if (process.platform !== "linux" || process.arch !== "x64") process.exit(0);

const root = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(root, "..", "node_modules");

function rm(path) {
  rmSync(path, { recursive: true, force: true });
}

function keepLinuxX64Prebuild(packageName) {
  const prebuilds = join(nodeModules, packageName, "prebuilds");
  if (!existsSync(prebuilds)) return;
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== "linux-x64") rm(join(prebuilds, entry));
  }
}

for (const packageName of [
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-typescript",
]) {
  keepLinuxX64Prebuild(packageName);
}

rm(join(nodeModules, "tree-sitter", "src"));
rm(join(nodeModules, "tree-sitter", "vendor"));

rm(join(nodeModules, "tree-sitter-javascript", "src"));
rm(join(nodeModules, "tree-sitter-javascript", "tree-sitter-javascript.wasm"));

rm(join(nodeModules, "tree-sitter-typescript", "typescript", "src"));
rm(join(nodeModules, "tree-sitter-typescript", "tsx", "src"));
rm(join(nodeModules, "tree-sitter-typescript", "tree-sitter-typescript.wasm"));
rm(join(nodeModules, "tree-sitter-typescript", "tree-sitter-tsx.wasm"));
