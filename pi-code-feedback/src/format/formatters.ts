import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCommand, walkUpInsideProject } from "../command-path.ts";
import type { FormatterCommandStatus } from "../types.ts";

export interface SelectedFormatter {
  id: string;
  label: string;
  command: string;
  args: string[];
  configPath?: string;
}

export type FormatterSelection =
  | { kind: "selected"; formatter: SelectedFormatter }
  | { kind: "unavailable"; id: string; label: string; command: string; reason: string }
  | { kind: "none"; reason: string };

interface FormatterOverride {
  disabled?: unknown;
  enabled?: unknown;
  command?: unknown;
  args?: unknown;
}

interface FormatterCandidate {
  id: string;
  label: string;
  command: string;
  extensions: string[];
  args(filePath: string): string[];
  configured(filePath: string, projectRoot: string, overrides: Record<string, unknown>): string | undefined | true;
}

const JS_TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const WEB_FORMAT_EXTENSIONS = [...JS_TS_EXTENSIONS, ".json", ".jsonc", ".css", ".scss", ".sass", ".less", ".html", ".htm"];
const LOCK_OR_GENERATED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
]);

const FORMATTERS: FormatterCandidate[] = [
  {
    id: "gofmt",
    label: "gofmt",
    command: "gofmt",
    extensions: [".go"],
    args: (filePath) => ["-w", filePath],
    configured: () => true,
  },
  {
    id: "rustfmt",
    label: "rustfmt",
    command: "rustfmt",
    extensions: [".rs"],
    args: (filePath) => [filePath],
    configured: () => true,
  },
  {
    id: "zig",
    label: "zig fmt",
    command: "zig",
    extensions: [".zig", ".zon"],
    args: (filePath) => ["fmt", filePath],
    configured: () => true,
  },
  {
    id: "biome",
    label: "Biome",
    command: "biome",
    extensions: WEB_FORMAT_EXTENSIONS,
    args: (filePath) => ["format", "--write", filePath],
    configured: (filePath, projectRoot, overrides) => findUp(path.dirname(filePath), projectRoot, ["biome.json", "biome.jsonc"]) ?? forced(overrides, "biome"),
  },
  {
    id: "prettier",
    label: "Prettier",
    command: "prettier",
    extensions: [...WEB_FORMAT_EXTENSIONS, ".md", ".mdx", ".yaml", ".yml"],
    args: (filePath) => ["--write", filePath],
    configured: prettierConfigured,
  },
  {
    id: "ruff",
    label: "Ruff format",
    command: "ruff",
    extensions: [".py", ".pyi"],
    args: (filePath) => ["format", filePath],
    configured: ruffConfigured,
  },
  {
    id: "black",
    label: "Black",
    command: "black",
    extensions: [".py", ".pyi"],
    args: (filePath) => ["--quiet", filePath],
    configured: blackConfigured,
  },
  {
    id: "shfmt",
    label: "shfmt",
    command: "shfmt",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    args: (filePath) => ["-w", filePath],
    configured: (_filePath, _projectRoot, overrides) => forced(overrides, "shfmt"),
  },
  {
    id: "stylua",
    label: "StyLua",
    command: "stylua",
    extensions: [".lua"],
    args: (filePath) => [filePath],
    configured: (filePath, projectRoot, overrides) => findUp(path.dirname(filePath), projectRoot, ["stylua.toml", ".stylua.toml"]) ?? forced(overrides, "stylua"),
  },
];

export function selectFormatter(filePath: string, projectRoot: string, overrides: Record<string, unknown> = {}): FormatterSelection {
  if (shouldSkipFormatting(filePath)) return { kind: "none", reason: "generated or lock file" };

  const extension = path.extname(filePath).toLowerCase();
  const candidates = FORMATTERS.filter((formatter) => formatter.extensions.includes(extension));
  if (candidates.length === 0) return { kind: "none", reason: "no formatter for extension" };

  for (const candidate of candidates) {
    const override = readOverride(overrides, candidate.id);
    if (override?.disabled === true || overrides[candidate.id] === false) continue;

    const configPath = candidate.configured(filePath, projectRoot, overrides);
    if (!configPath) continue;

    const command = typeof override?.command === "string" && override.command.length > 0 ? override.command : candidate.command;
    const resolvedCommand = resolveCommand(command, path.dirname(filePath), projectRoot);
    if (!resolvedCommand) {
      return {
        kind: "unavailable",
        id: candidate.id,
        label: candidate.label,
        command,
        reason: `command not found on PATH or node_modules/.bin: ${command}`,
      };
    }

    return {
      kind: "selected",
      formatter: {
        id: candidate.id,
        label: candidate.label,
        command: resolvedCommand,
        args: formatterArgs(candidate, override, filePath),
        configPath: typeof configPath === "string" ? configPath : undefined,
      },
    };
  }

  return { kind: "none", reason: "no configured formatter" };
}

function shouldSkipFormatting(filePath: string): boolean {
  const base = path.basename(filePath);
  return LOCK_OR_GENERATED_BASENAMES.has(base) || base.endsWith(".min.js") || base.endsWith(".min.css");
}

export function listFormatterCommandStatus(projectRoot: string): FormatterCommandStatus[] {
  const seen = new Set<string>();
  const statuses: FormatterCommandStatus[] = [];

  for (const formatter of FORMATTERS) {
    if (seen.has(formatter.id)) continue;
    seen.add(formatter.id);
    const available = resolveCommand(formatter.command, projectRoot, projectRoot) !== undefined;
    statuses.push({
      id: formatter.id,
      label: formatter.label,
      command: formatter.command,
      available,
      reason: available ? undefined : "not found",
    });
  }

  return statuses;
}

function formatterArgs(candidate: FormatterCandidate, override: FormatterOverride | undefined, filePath: string): string[] {
  if (Array.isArray(override?.args) && override.args.every((arg) => typeof arg === "string")) {
    return override.args.map((arg) => arg.replaceAll("{file}", filePath));
  }
  return candidate.args(filePath);
}

function prettierConfigured(filePath: string, projectRoot: string, overrides: Record<string, unknown>): string | undefined | true {
  return (
    findUp(path.dirname(filePath), projectRoot, [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.json5",
      ".prettierrc.yml",
      ".prettierrc.yaml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
      "prettier.config.ts",
      "prettier.config.mts",
      "prettier.config.cts",
    ])
    ?? packageJsonHas(path.dirname(filePath), projectRoot, (json) => Object.prototype.hasOwnProperty.call(json, "prettier"))
    ?? packageJsonHasDependency(path.dirname(filePath), projectRoot, ["prettier"])
    ?? forced(overrides, "prettier")
  );
}

function ruffConfigured(filePath: string, projectRoot: string, overrides: Record<string, unknown>): string | undefined | true {
  return (
    findUp(path.dirname(filePath), projectRoot, ["ruff.toml", ".ruff.toml"])
    ?? pyprojectHas(path.dirname(filePath), projectRoot, "[tool.ruff")
    ?? forced(overrides, "ruff")
  );
}

function blackConfigured(filePath: string, projectRoot: string, overrides: Record<string, unknown>): string | undefined | true {
  return pyprojectHas(path.dirname(filePath), projectRoot, "[tool.black]") ?? forced(overrides, "black");
}

function forced(overrides: Record<string, unknown>, id: string): true | undefined {
  const value = overrides[id];
  if (value === true) return true;
  const override = readOverride(overrides, id);
  return override?.enabled === true ? true : undefined;
}

function readOverride(overrides: Record<string, unknown>, id: string): FormatterOverride | undefined {
  const value = overrides[id];
  return value && typeof value === "object" ? (value as FormatterOverride) : undefined;
}

function findUp(startDir: string, projectRoot: string, names: string[]): string | undefined {
  for (const dir of walkUpInsideProject(startDir, projectRoot)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function packageJsonHas(startDir: string, projectRoot: string, predicate: (json: Record<string, unknown>) => boolean): string | undefined {
  for (const dir of walkUpInsideProject(startDir, projectRoot)) {
    const packageJson = path.join(dir, "package.json");
    if (!fs.existsSync(packageJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as Record<string, unknown>;
      if (predicate(parsed)) return packageJson;
    } catch {
      // Ignore malformed package.json for formatter detection.
    }
  }
  return undefined;
}

function packageJsonHasDependency(startDir: string, projectRoot: string, names: string[]): string | undefined {
  return packageJsonHas(startDir, projectRoot, (json) => {
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = json[key];
      if (!deps || typeof deps !== "object") continue;
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(deps, name)) return true;
      }
    }
    return false;
  });
}

function pyprojectHas(startDir: string, projectRoot: string, needle: string): string | undefined {
  for (const dir of walkUpInsideProject(startDir, projectRoot)) {
    const pyproject = path.join(dir, "pyproject.toml");
    if (!fs.existsSync(pyproject)) continue;
    try {
      if (fs.readFileSync(pyproject, "utf8").includes(needle)) return pyproject;
    } catch {
      // Ignore unreadable pyproject.toml for formatter detection.
    }
  }
  return undefined;
}

