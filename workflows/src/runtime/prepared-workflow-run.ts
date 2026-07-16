import fs from "node:fs";
import path from "node:path";
import { SemanticApplyAdapter } from "../apply/semantic-adapter.js";
import { HostAgentMediatedToolExecutor } from "../agents/host-mediator.js";
import { KagiWebMediator } from "../agents/kagi-mediator.js";
import { SdkAgentWorkerExecutor } from "../agents/sdk-executor.js";
import { SemanticAgentAdapter } from "../agents/semantic-adapter.js";
import type { PreparedWorkflowExecutionResources } from "../agents/resources.js";
import { SemanticAcceptAdapter, SemanticRejectAdapter } from "../candidates/disposition-adapters.js";
import { createOpaqueLaunchSnapshotRef } from "../candidates/refs.js";
import { SemanticCandidateAdapter } from "../candidates/semantic-adapter.js";
import { CandidateWorkspaceManager } from "../candidates/store.js";
import { SandboxedCommandExecutor } from "../commands/executor.js";
import { SemanticCommandAdapter } from "../commands/semantic-adapter.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { ParsedStructuredWorkflow } from "../definition/types.js";
import {
  STRUCTURED_RUNTIME_API_HASH,
  STRUCTURED_RUNTIME_API_VERSION,
  parseStructuredWorkflow,
  structuredWorkflowDefinitionHash,
} from "../definition/workflow-definition.js";
import { SemanticExperimentAdapter } from "../experiments/adapter.js";
import { SemanticMeasurementAdapter } from "../measurements/adapter.js";
import { HostMeasurementEnvironmentProvider } from "../measurements/environment.js";
import { RunDatabase } from "../persistence/run-database.js";
import type { JsonObject } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { CurrentVerificationAuthority } from "../verification/current-authority.js";
import { SemanticVerificationAdapter } from "../verification/semantic-adapter.js";
import { HostVerificationEvidenceProvider } from "../verification/host-evidence.js";
import {
  assertProjectSnapshotManifest,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import type { RunRecord } from "./durable-types.js";
import { executeSequentialSemanticRun, type SequentialSemanticRunOutcome } from "./semantic-engine.js";

const SOURCE_BYTES = 2 * 1024 * 1024;
const CONTEXT_JSON_BYTES = 8 * 1024 * 1024;

export interface PersistedWorkflowInvocation {
  formatVersion: 1;
  workflowId: string;
  sourceHash: string;
  definitionHash: string;
  runtimeApiVersion: number;
  runtimeApiHash: string;
  input: JsonObject;
  inputHash: string;
}

interface ReplayBinding {
  formatVersion: 1;
  sourceRunId: string;
  sourceRunDir: string;
  fresh: boolean;
}

/** Reconstructs only snapshotted authority, then runs the one semantic engine. */
export async function executePreparedWorkflowRun(
  runDirInput: string,
  database: RunDatabase,
  signal?: AbortSignal,
): Promise<SequentialSemanticRunOutcome> {
  const runDir = path.resolve(runDirInput);
  if (path.resolve(database.databasePath) !== path.join(runDir, "run.sqlite")) {
    throw new Error("Prepared workflow runtime and database directories differ");
  }
  const [source, invocation, resources, manifest, replay] = await Promise.all([
    readText(path.join(runDir, "source.flow.js"), SOURCE_BYTES),
    readCanonicalJson<unknown>(path.join(runDir, "context", "invocation.json")),
    readCanonicalJson<PreparedWorkflowExecutionResources>(path.join(runDir, "context", "resources.json")),
    readCanonicalJson<ProjectSnapshotManifest>(
      path.join(runDir, "context", "project-manifest.json"),
      DEFINITION_LIMITS.projectManifestBytes,
    ),
    readOptionalCanonicalJson<ReplayBinding>(path.join(runDir, "context", "replay.json")),
  ]);
  const run = database.readRun();
  const parsed = parseStructuredWorkflow(source);
  assertProjectSnapshotManifest(manifest);
  assertPreparedWorkflowInvocation(run, parsed, invocation);
  assertResources(run, resources, manifest);

  const projectRoot = path.join(runDir, "context", "project");
  const projectCwd = path.resolve(projectRoot, manifest.cwd === "." ? "" : manifest.cwd);
  assertContained(projectRoot, projectCwd, true);
  const launchWorkspace = {
    root: projectRoot,
    cwd: projectCwd,
    workspace: {
      kind: "snapshot" as const,
      workspaceId: `snapshot_${stableHash({ runId: run.runId, treeHash: manifest.treeHash }).slice(7, 39)}`,
      treeHash: manifest.treeHash,
    },
  };

  const candidateManager = await CandidateWorkspaceManager.open(runDir, database);
  const agentExecutor = new SdkAgentWorkerExecutor();
  const commandExecutor = new SandboxedCommandExecutor();
  const webKey = process.env.PI_WORKFLOW_KAGI_API_KEY ?? process.env.KAGI_API_KEY;
  const mediatedTools = new HostAgentMediatedToolExecutor({
    ...(webKey ? { web: new KagiWebMediator({ apiKey: webKey }) } : {}),
    maximumCommandOutputBytes: 8 * 1024 * 1024,
  });
  const agentAdapter = new SemanticAgentAdapter({
    runDir,
    database,
    resources,
    executor: agentExecutor,
    candidateManager,
    mediatedTools,
  });
  const verificationEvidence = new HostVerificationEvidenceProvider({
    runDir,
    database,
    resources,
    commandExecutor,
    agentAdapter,
  });
  const currentVerificationAuthority = new CurrentVerificationAuthority({
    projectCwd: resources.projectCwd,
    resources,
    commandExecutor,
    agentExecutor,
  });
  const measurementEnvironment = new HostMeasurementEnvironmentProvider();
  if (resources.measurementEnvironment
    && stableHash(resources.measurementEnvironment) !== stableHash(measurementEnvironment.describe())) {
    throw new Error("Measurement environment provider differs from its pinned protocol");
  }

  const adapters = [
    agentAdapter,
    new SemanticCommandAdapter({
      runDir,
      database,
      profiles: resources.commands,
      executor: commandExecutor,
      ...(resources.commandExecutor ? { pinnedExecutor: resources.commandExecutor } : {}),
      launchWorkspace,
      candidateManager,
    }),
    new SemanticCandidateAdapter({ manager: candidateManager }),
    new SemanticVerificationAdapter({
      runDir,
      database,
      profiles: resources.verifications,
      evidence: verificationEvidence,
    }),
    new SemanticAcceptAdapter({ runDir, database }),
    new SemanticRejectAdapter({ runDir, database }),
    new SemanticMeasurementAdapter({
      runDir,
      database,
      profiles: resources.measurements,
      environment: measurementEnvironment,
      executor: commandExecutor,
      launchWorkspace,
    }),
    new SemanticExperimentAdapter({ runDir, database }),
    new SemanticApplyAdapter({
      runDir,
      database,
      currentVerificationBinding: (verification) => currentVerificationAuthority.binding(verification),
    }),
  ];
  const replaySourceRunDir = replaySource(runDir, run.runId, run.replay, replay);
  return await executeSequentialSemanticRun(runDir, database, parsed, {
    workflowId: invocation.workflowId,
    definitionHash: invocation.definitionHash,
    input: invocation.input,
    inputHash: invocation.inputHash,
  }, adapters, {
    snapshot: createOpaqueLaunchSnapshotRef({ runId: run.runId, snapshotHash: run.projectSnapshotHash }),
    controlPollIntervalMs: 25,
    ...(signal ? { signal } : {}),
    ...(replaySourceRunDir ? { replaySourceRunDir } : {}),
  });
}

export function assertPreparedWorkflowInvocation(
  run: {
    workflow: Pick<RunRecord["workflow"], "id" | "name" | "sourceHash" | "definitionHash">;
  },
  parsed: ParsedStructuredWorkflow,
  invocation: unknown,
): asserts invocation is PersistedWorkflowInvocation {
  if (!plainRecord(invocation) || invocation.formatVersion !== 1
    || typeof invocation.workflowId !== "string" || typeof invocation.sourceHash !== "string"
    || typeof invocation.definitionHash !== "string"
    || !Number.isSafeInteger(invocation.runtimeApiVersion) || typeof invocation.runtimeApiHash !== "string"
    || !plainRecord(invocation.input) || typeof invocation.inputHash !== "string") {
    throw new Error("Persisted workflow invocation is invalid");
  }
  if (invocation.workflowId !== run.workflow.id || invocation.definitionHash !== run.workflow.definitionHash) {
    throw new Error("Persisted workflow invocation belongs to another run");
  }
  if (
    invocation.runtimeApiVersion !== STRUCTURED_RUNTIME_API_VERSION
    || invocation.runtimeApiHash !== STRUCTURED_RUNTIME_API_HASH
  ) {
    throw new Error(
      "Prepared workflow requires a different structured-runtime revision "
      + `(prepared v${invocation.runtimeApiVersion} ${invocation.runtimeApiHash}, `
      + `current v${STRUCTURED_RUNTIME_API_VERSION} ${STRUCTURED_RUNTIME_API_HASH}); start a new run`,
    );
  }
  if (stableHash(invocation.input) !== invocation.inputHash) throw new Error("Persisted workflow input hash is corrupt");
  if (
    invocation.sourceHash !== parsed.sourceHash
    || parsed.sourceHash !== run.workflow.sourceHash
    || parsed.metadata.name !== run.workflow.name
  ) {
    throw new Error("Persisted workflow source belongs to another run");
  }
  const currentDefinitionHash = structuredWorkflowDefinitionHash({
    workflowId: run.workflow.id,
    metadata: parsed.metadata,
    sourceHash: parsed.sourceHash,
    runtimeApiVersion: STRUCTURED_RUNTIME_API_VERSION,
    runtimeApiHash: STRUCTURED_RUNTIME_API_HASH,
    review: parsed.review,
  });
  if (currentDefinitionHash !== invocation.definitionHash) {
    throw new Error("Persisted workflow definition changed under the current structured-runtime revision; start a new run");
  }
}

function assertResources(
  run: ReturnType<RunDatabase["readRun"]>,
  resources: PreparedWorkflowExecutionResources,
  manifest: ProjectSnapshotManifest,
): void {
  if (!plainRecord(resources) || resources.formatVersion !== 1 || typeof resources.hash !== "string") {
    throw new Error("Pinned workflow resources are invalid");
  }
  const { hash, ...body } = resources;
  if (stableHash(body) !== hash) throw new Error("Pinned workflow resource hash is corrupt");
  if (resources.definitionSourceHash !== run.workflow.sourceHash
    || resources.routeSnapshotHash !== run.routeSnapshotHash
    || manifest.treeHash !== run.projectSnapshotHash) {
    throw new Error("Pinned workflow resources differ from the run identity");
  }
  if (path.resolve(resources.projectRoot) !== path.resolve(manifest.sourceRoot)) {
    throw new Error("Pinned workflow project root differs from the launch manifest");
  }
}

function replaySource(
  runDir: string,
  runId: string,
  replay: ReturnType<RunDatabase["readRun"]>["replay"],
  binding: ReplayBinding | undefined,
): string | undefined {
  if (!replay) {
    if (binding) throw new Error("Unexpected replay binding on a fresh run");
    return undefined;
  }
  if (!binding || binding.formatVersion !== 1 || binding.sourceRunId !== replay.sourceRunId
    || binding.fresh !== replay.fresh || !path.isAbsolute(binding.sourceRunDir)) {
    throw new Error("Persisted replay binding is invalid");
  }
  const source = path.resolve(binding.sourceRunDir);
  if (source === runDir || path.basename(source) !== binding.sourceRunId || binding.sourceRunId === runId) {
    throw new Error("Persisted replay source identity is invalid");
  }
  return replay.fresh ? undefined : source;
}

async function readText(filePath: string, maximumBytes: number): Promise<string> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error(`Unsafe prepared run file ${filePath}`);
  return await fs.promises.readFile(filePath, "utf8");
}

async function readCanonicalJson<T>(filePath: string, maximumBytes = CONTEXT_JSON_BYTES): Promise<T> {
  const source = await readText(filePath, maximumBytes);
  const value = JSON.parse(source) as T;
  if (source !== `${stableJson(value)}\n`) throw new Error(`Prepared run file is not canonical: ${filePath}`);
  return value;
}

async function readOptionalCanonicalJson<T>(filePath: string): Promise<T | undefined> {
  try { return await readCanonicalJson<T>(filePath); }
  catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function assertContained(rootInput: string, targetInput: string, allowSame = false): void {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if ((!allowSame && relative === "") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Prepared workflow cwd escapes the launch snapshot");
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
