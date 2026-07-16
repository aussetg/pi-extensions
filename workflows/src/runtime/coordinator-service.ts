import fs from "node:fs";
import path from "node:path";
import { RunDatabaseReader } from "../persistence/run-database.js";
import {
  SystemdUserUnitLauncher,
  WorkflowUnitClaimError,
  type SystemdUserUnitLauncherOptions,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import { coordinatorEntryPath } from "./run-coordinator.js";

export class CoordinatorAlreadyRunningError extends Error {
  readonly runId: string;
  readonly unit: string;

  constructor(runId: string, unit: string) {
    super(`Coordinator ${unit} is already active`);
    this.name = "CoordinatorAlreadyRunningError";
    this.runId = runId;
    this.unit = unit;
  }
}

export interface CoordinatorServiceOptions extends SystemdUserUnitLauncherOptions {
  launcher?: SystemdUserUnitLauncher;
  nodePath?: string;
  entryPath?: string;
}

export interface CoordinatorServiceLaunch {
  runId: string;
  unit: string;
  handle: WorkflowUnitHandle;
}

/** Thin extension-side launcher. It keeps no ownership map or teardown hook. */
export class CoordinatorService {
  readonly launcher: SystemdUserUnitLauncher;
  readonly nodePath: string;
  readonly entryPath: string;

  constructor(options: CoordinatorServiceOptions = {}) {
    this.launcher = options.launcher ?? new SystemdUserUnitLauncher(options);
    this.nodePath = path.resolve(options.nodePath ?? "/usr/bin/node");
    this.entryPath = path.resolve(options.entryPath ?? coordinatorEntryPath());
  }

  async launch(runDirInput: string): Promise<CoordinatorServiceLaunch> {
    await Promise.all([
      fs.promises.access(this.nodePath, fs.constants.X_OK),
      fs.promises.access(this.entryPath, fs.constants.R_OK),
    ]);
    const { runDir, runId } = await inspectRunDirectory(runDirInput);
    const unit = coordinatorUnitName(runId);
    const state = await this.launcher.inspect(unit);
    if (isActive(state.activeState)) throw new CoordinatorAlreadyRunningError(runId, unit);
    if (state.loadState !== "not-found") {
      const cleanup = await this.launcher.collect(unit);
      if (!cleanup.collected) throw new Error(`Could not collect prior coordinator unit ${unit}`);
    }

    try {
      const handle = await this.launcher.launch({
        kind: "coordinator",
        id: runId,
        argv: [this.nodePath, "--experimental-transform-types", this.entryPath, "--run-dir", runDir],
        workingDirectory: runDir,
        environment: {
          PI_WORKFLOW_COORDINATOR_UNIT: unit,
          NODE_NO_WARNINGS: "1",
          ...operationalCredentialEnvironment(),
        },
      });
      return { runId, unit, handle };
    } catch (error) {
      if (error instanceof WorkflowUnitClaimError) {
        const raced = await this.launcher.inspect(unit);
        if (isActive(raced.activeState)) throw new CoordinatorAlreadyRunningError(runId, unit);
      }
      throw error;
    }
  }
}

async function inspectRunDirectory(runDirInput: string): Promise<{ runDir: string; runId: string }> {
  const runDir = path.resolve(runDirInput);
  const databasePath = path.join(runDir, "run.sqlite");
  const [root, database, realRoot] = await Promise.all([
    fs.promises.lstat(runDir),
    fs.promises.lstat(databasePath),
    fs.promises.realpath(runDir),
  ]);
  if (!root.isDirectory() || root.isSymbolicLink() || realRoot !== runDir) throw new Error("Unsafe coordinator run directory");
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("Unsafe coordinator run database");
  const reader = RunDatabaseReader.open(databasePath);
  try {
    const runId = reader.readRun().runId;
    if (path.basename(runDir) !== runId || !/^flow_[a-f0-9]{32}$/.test(runId)) {
      throw new Error("Coordinator run directory and database identity differ");
    }
    return { runDir, runId };
  } finally {
    reader.close();
  }
}

function isActive(activeState: string): boolean {
  return ["active", "activating", "deactivating", "reloading"].includes(activeState);
}

/** Operational transport only: these values are never written to run context or semantic hashes. */
function operationalCredentialEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  const direct = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
  ];
  for (const name of direct) {
    const value = process.env[name];
    if (value && value.length <= 16_384 && !/[\u0000\r\n]/.test(value)) result[name] = value;
  }
  const kagi = process.env.KAGI_API_KEY;
  if (kagi && kagi.length <= 4_096 && !/[\u0000\r\n]/.test(kagi)) result.PI_WORKFLOW_KAGI_API_KEY = kagi;
  return result;
}

