import fs from "node:fs";
import path from "node:path";
import { WorkflowRunDatabaseReader } from "../persistence/run-database.js";
import {
  SystemdUserUnitLauncher,
  WorkflowUnitClaimError,
  type SystemdUserUnitLauncherOptions,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import { workflowCoordinatorEntryPath } from "./entry-paths.js";

export class WorkflowCoordinatorAlreadyRunningError extends Error {
  constructor(readonly runId: string, readonly unit: string) {
    super(`Coordinator ${unit} is already active`);
    this.name = "WorkflowCoordinatorAlreadyRunningError";
  }
}

export class WorkflowCoordinatorService {
  readonly launcher: SystemdUserUnitLauncher;
  readonly nodePath: string;
  readonly entryPath: string;

  constructor(options: SystemdUserUnitLauncherOptions & {
    launcher?: SystemdUserUnitLauncher;
    nodePath?: string;
    entryPath?: string;
  } = {}) {
    this.launcher = options.launcher ?? new SystemdUserUnitLauncher(options);
    this.nodePath = path.resolve(options.nodePath ?? "/usr/bin/node");
    this.entryPath = path.resolve(options.entryPath ?? workflowCoordinatorEntryPath());
  }

  async launch(runDirInput: string): Promise<{ runId: string; unit: string; handle: WorkflowUnitHandle }> {
    await Promise.all([
      fs.promises.access(this.nodePath, fs.constants.X_OK),
      fs.promises.access(this.entryPath, fs.constants.R_OK),
    ]);
    const runDir = path.resolve(runDirInput);
    const reader = WorkflowRunDatabaseReader.open(path.join(runDir, "run.sqlite"));
    let runId: string;
    try { runId = reader.readRun().runId; } finally { reader.close(); }
    if (path.basename(runDir) !== runId) throw new Error("Coordinator directory differs from run identity");
    const unit = coordinatorUnitName(runId);
    const state = await this.launcher.inspect(unit);
    if (active(state.activeState)) throw new WorkflowCoordinatorAlreadyRunningError(runId, unit);
    if (state.loadState !== "not-found") {
      const cleanup = await this.launcher.collect(unit);
      if (!cleanup.collected) throw new Error(`Could not collect prior coordinator ${unit}`);
    }
    try {
      const handle = await this.launcher.launch({
        kind: "coordinator",
        id: runId,
        argv: [this.nodePath, "--experimental-transform-types", this.entryPath, "--run-dir", runDir],
        workingDirectory: runDir,
        environment: {
          NODE_NO_WARNINGS: "1",
          PI_WORKFLOW_COORDINATOR_UNIT: unit,
          ...credentials(),
        },
      });
      return { runId, unit, handle };
    } catch (error) {
      if (error instanceof WorkflowUnitClaimError && active((await this.launcher.inspect(unit)).activeState)) {
        throw new WorkflowCoordinatorAlreadyRunningError(runId, unit);
      }
      throw error;
    }
  }
}

function active(value: string): boolean {
  return ["active", "activating", "deactivating", "reloading"].includes(value);
}

function credentials(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
    "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AZURE_OPENAI_API_KEY",
  ]) {
    const value = process.env[name];
    if (value && value.length <= 16_384 && !/[\u0000\r\n]/u.test(value)) result[name] = value;
  }
  const kagi = process.env.PI_WORKFLOW_KAGI_API_KEY ?? process.env.KAGI_API_KEY;
  if (kagi && kagi.length <= 4_096 && !/[\u0000\r\n]/u.test(kagi)) result.PI_WORKFLOW_KAGI_API_KEY = kagi;
  return result;
}
