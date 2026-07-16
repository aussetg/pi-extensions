import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const PROJECT_CONFIG_DIR_NAME = CONFIG_DIR_NAME;

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** One machine-wide root contains every SQLite-backed workflow run. */
export function workflowRunRoot(agentDir = getAgentDir()): string {
  return path.join(path.resolve(agentDir), "workflow-runs");
}

/** Drafts are deliberately separate from both installed workflows and runs. */
export function workflowDraftRoot(agentDir = getAgentDir()): string {
  return path.join(path.resolve(agentDir), "workflow-drafts");
}

export interface RunFilesystemPaths {
  root: string;
  database: string;
  source: string;
  context: string;
  invocation: string;
  projectSnapshot: string;
  projectManifest: string;
  contextIdentity: string;
  sessions: string;
  workspaces: string;
  artifacts: string;
  outputs: string;
}

export function runFilesystemPaths(runRoot: string, runId: string): RunFilesystemPaths {
  if (!/^flow_[a-f0-9]{32}$/.test(runId)) throw new TypeError("Invalid workflow run id");
  const root = path.join(path.resolve(runRoot), runId);
  return Object.freeze({
    root,
    database: path.join(root, "run.sqlite"),
    source: path.join(root, "source.flow.js"),
    context: path.join(root, "context"),
    invocation: path.join(root, "context", "invocation.json"),
    projectSnapshot: path.join(root, "context", "project"),
    projectManifest: path.join(root, "context", "project-manifest.json"),
    contextIdentity: path.join(root, "context", "identity.json"),
    sessions: path.join(root, "sessions"),
    workspaces: path.join(root, "workspaces"),
    artifacts: path.join(root, "artifacts"),
    outputs: path.join(root, "outputs"),
  });
}

export function userWorkflowDir(): string {
  return path.join(getAgentDir(), "workflows");
}

export function userCommandProfileDir(): string {
  return path.join(getAgentDir(), "commands");
}

export function projectRoot(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  const requested = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  let current = requested;
  while (true) {
    const projectConfig = current !== home && existsDir(path.join(current, configDirName));
    if (existsDir(path.join(current, ".git")) || projectConfig) return current;
    const parent = path.dirname(current);
    if (parent === current) return requested;
    current = parent;
  }
}

export function projectWorkflowDir(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  return path.join(projectRoot(cwd, configDirName), configDirName, "workflows");
}

export function projectCommandProfileDir(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string {
  return path.join(projectRoot(cwd, configDirName), configDirName, "commands");
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
