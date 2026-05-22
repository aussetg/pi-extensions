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

const nativePackages = [
  "tree-sitter",
  "@tree-sitter-grammars/tree-sitter-toml",
  "@tree-sitter-grammars/tree-sitter-yaml",
  "@tree-sitter-grammars/tree-sitter-zig",
  "tree-sitter-bash",
  "tree-sitter-c",
  "tree-sitter-cpp",
  "tree-sitter-css",
  "tree-sitter-go",
  "tree-sitter-haskell",
  "tree-sitter-html",
  "tree-sitter-java",
  "tree-sitter-javascript",
  "tree-sitter-json",
  "tree-sitter-julia",
  "tree-sitter-php",
  "tree-sitter-python",
  "tree-sitter-regex",
  "tree-sitter-ruby",
  "tree-sitter-rust",
  "tree-sitter-typescript",
];

for (const packageName of nativePackages) {
  keepLinuxX64Prebuild(packageName);
}

rm(join(nodeModules, "tree-sitter", "src"));
rm(join(nodeModules, "tree-sitter", "vendor"));

for (const packageName of nativePackages.filter((name) => name !== "tree-sitter")) {
  rm(join(nodeModules, packageName, "src"));
  rm(join(nodeModules, packageName, "grammar"));
}

rm(join(nodeModules, "tree-sitter-typescript", "typescript", "src"));
rm(join(nodeModules, "tree-sitter-typescript", "tsx", "src"));
rm(join(nodeModules, "tree-sitter-typescript", "tree-sitter-typescript.wasm"));
rm(join(nodeModules, "tree-sitter-typescript", "tree-sitter-tsx.wasm"));

rm(join(nodeModules, "tree-sitter-php", "php", "src"));
rm(join(nodeModules, "tree-sitter-php", "php_only", "src"));
