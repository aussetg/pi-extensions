import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { shortHash } from "../utils/hashes.js";
import { slugify } from "../utils/ids.js";

export const PROJECT_CONFIG_DIR_NAME = CONFIG_DIR_NAME;

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function workflowHome(): string {
  return path.join(getAgentDir(), "workflows");
}

export function runRootForCwd(cwd: string): string {
  return path.join(workflowHome(), "runs", shortHash(path.resolve(cwd), 16));
}

export function userWorkflowDir(): string {
  return workflowHome();
}

export function projectRoot(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  let current = path.resolve(cwd);
  while (true) {
    if (existsDir(path.join(current, ".git")) || existsDir(path.join(current, configDirName))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function projectWorkflowDir(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  return path.join(projectRoot(cwd, configDirName), configDirName, "workflows");
}

export function workflowFilePath(scope: "user" | "project", cwd: string, name: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  const dir = scope === "project" ? projectWorkflowDir(cwd, configDirName) : userWorkflowDir();
  return path.join(dir, `${slugify(name)}.js`);
}

export function resolveLocalPath(cwd: string, rawPath: string): string {
  if (/^\\\\/.test(rawPath)) throw new Error(`Network/UNC paths are not allowed: ${rawPath}`);
  const resolved = path.resolve(cwd, rawPath.replace(/^@/, ""));
  if (resolved.includes("\0")) throw new Error("NUL bytes are not allowed in paths");
  return resolved;
}

export function relativeToRun(runDir: string, filePath: string): string {
  return path.relative(runDir, filePath).split(path.sep).join("/");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
