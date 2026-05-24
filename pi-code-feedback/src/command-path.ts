import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const commandAvailabilityCache = new Map<string, boolean>();

export interface CommandResolutionOptions {
  extraBinDirs?: string[];
}

export function resolveCommand(command: string, startDir: string, projectRoot: string, options: CommandResolutionOptions = {}): string | undefined {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return fs.existsSync(command) ? command : undefined;
  }

  const extra = findInBinDirs(command, options.extraBinDirs ?? []);
  if (extra) return extra;

  const local = findLocalBin(command, startDir, projectRoot);
  if (local) return local;

  return commandExists(command) ? command : undefined;
}

export function walkUpInsideProject(startDir: string, projectRoot: string): string[] {
  const root = path.resolve(projectRoot);
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    if (isInsideOrEqual(current, root)) dirs.push(current);
    if (current === root || current === path.dirname(current)) break;
    current = path.dirname(current);
  }

  return dirs;
}

function findInBinDirs(command: string, binDirs: string[]): string | undefined {
  for (const dir of binDirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findLocalBin(command: string, startDir: string, projectRoot: string): string | undefined {
  for (const dir of walkUpInsideProject(startDir, projectRoot)) {
    const candidate = path.join(dir, "node_modules", ".bin", command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function commandExists(command: string): boolean {
  const cached = commandAvailabilityCache.get(command);
  if (cached !== undefined) return cached;

  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
  const available = result.status === 0;
  commandAvailabilityCache.set(command, available);
  return available;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
