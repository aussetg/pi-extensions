import fs from "node:fs";
import path from "node:path";
import { SdkAgentWorkerExecutor } from "../agents/sdk-executor.js";
import { AgentProtocolServer } from "../agents/sdk-protocol-server.js";
import { HostAgentMediatedToolExecutor } from "../agents/host-mediator.js";
import { KagiWebMediator } from "../agents/kagi-mediator.js";
import { WorkflowArtifactStore } from "../artifacts/store.js";
import { WorkflowEffectProductFactory } from "../artifacts/products.js";
import { WorkflowCandidateRuntime, WorkflowFilesystemCandidateDriver } from "../candidates/runtime.js";
import { scanCandidateTree } from "../candidates/tree.js";
import { SandboxedCommandExecutor } from "../commands/executor.js";
import { parseWorkflow } from "../definition/workflow-frontend.js";
import { HostMeasurementEnvironmentProvider } from "../measurements/environment.js";
import { WorkflowMetricSetRuntime } from "../measurements/metric-set.js";
import { WorkflowRunDatabase } from "../persistence/run-database.js";
import { readWorkflowInvocationSnapshot } from "../persistence/workflow-invocation.js";
import { assertProjectSnapshotManifest, type ProjectSnapshotManifest } from "../workspaces/project-snapshot.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { WorkflowCausalReplay } from "./causal-replay.js";
import { WorkflowControlAuthorityRegistry } from "./control-authority.js";
import { assertWorkflowStaticEffectResources, type WorkflowStaticEffectResources } from "./effect-adapters.js";
import { WorkflowExecutableRuntime } from "./executable-runtime.js";
import {
  WorkflowProductionAgentExecutor,
  WorkflowProductionApplyExecutor,
  WorkflowProductionAskExecutor,
  WorkflowProductionCommandExecutor,
  WorkflowProductionVerificationExecutor,
} from "./production-effects.js";

export interface WorkflowReplayBinding {
  formatVersion: 1;
  sourceRunId: string;
  sourceRunDir: string;
  fresh: boolean;
}

/** Reconstruct exact snapshotted authority and execute one prepared schema-4 run. */
export async function executePreparedWorkflowRun(
  runDirInput: string,
  database: WorkflowRunDatabase,
  signal?: AbortSignal,
) {
  const runDir = path.resolve(runDirInput);
  if (path.resolve(database.databasePath) !== path.join(runDir, "run.sqlite")) {
    throw new Error("Prepared workflow runtime and database directories differ");
  }
  const [snapshot, resources, manifest, replayBinding] = await Promise.all([
    readWorkflowInvocationSnapshot(runDir),
    readCanonical<WorkflowStaticEffectResources>(path.join(runDir, "context", "static-resources.json")),
    readCanonical<ProjectSnapshotManifest>(path.join(runDir, "context", "project-manifest.json")),
    readOptional<WorkflowReplayBinding>(path.join(runDir, "context", "replay.json")),
  ]);
  assertProjectSnapshotManifest(manifest);
  const workflow = parseWorkflow(snapshot.source, { fileName: `${snapshot.name}.flow.ts` });
  assertWorkflowStaticEffectResources(workflow, resources);
  const run = database.readRun();
  if (run.workflow.snapshotHash !== snapshot.snapshotHash || run.staticResourcesHash !== resources.hash
    || run.projectSnapshotHash !== manifest.treeHash || run.workflow.definitionHash !== snapshot.definitionHash) {
    throw new Error("Prepared workflow authority differs from its run database");
  }
  const projectRoot = path.join(runDir, "context", "project");
  const projectCwd = path.resolve(projectRoot, manifest.cwd === "." ? "" : manifest.cwd);
  if ((await scanCandidateTree(projectRoot)).treeHash !== manifest.treeHash) {
    throw new Error("Prepared workflow project snapshot tree is corrupt");
  }
  const authority = new WorkflowControlAuthorityRegistry(`${run.runId}:${snapshot.definitionHash}`);
  const artifacts = new WorkflowArtifactStore(runDir, database);
  const products = new WorkflowEffectProductFactory(authority, artifacts);
  const candidateDriver = new WorkflowFilesystemCandidateDriver(
    runDir,
    database,
    artifacts,
    manifest,
  );
  const candidates = new WorkflowCandidateRuntime(database, authority, candidateDriver);
  const commandExecutor = new SandboxedCommandExecutor();
  const environment = new HostMeasurementEnvironmentProvider();
  const metrics = workflow.operations.some(operation => operation.method === "metrics")
    ? new WorkflowMetricSetRuntime(database, products, workflow)
    : undefined;
  const webKey = process.env.PI_WORKFLOW_KAGI_API_KEY ?? process.env.KAGI_API_KEY;
  const mediated = new HostAgentMediatedToolExecutor({
    ...(webKey ? { web: new KagiWebMediator({ apiKey: webKey }) } : {}),
    maximumCommandOutputBytes: 8 * 1024 * 1024,
  });
  const protocol = new AgentProtocolServer(runDir, database, artifacts, { mediatedTools: mediated });
  await protocol.start();
  const agent = new WorkflowProductionAgentExecutor(
    new SdkAgentWorkerExecutor(),
    protocol,
    { root: projectRoot, cwd: projectCwd, treeHash: manifest.treeHash },
  );
  const command = new WorkflowProductionCommandExecutor(
    runDir,
    commandExecutor,
    { root: projectRoot, cwd: projectCwd },
  );
  const verification = new WorkflowProductionVerificationExecutor(runDir, commandExecutor, agent);
  const ask = new WorkflowProductionAskExecutor(database);
  const apply = new WorkflowProductionApplyExecutor(
    database,
    manifest.sourceRoot,
    projectRoot,
    manifest.treeHash,
  );
  let replay: WorkflowCausalReplay | undefined;
  try {
    if (replayBinding && !replayBinding.fresh) {
      if (replayBinding.formatVersion !== 1 || replayBinding.sourceRunId !== path.basename(replayBinding.sourceRunDir)) {
        throw new Error("Prepared workflow replay binding is invalid");
      }
      replay = await WorkflowCausalReplay.open({
        targetRunDir: runDir,
        target: database,
        sourceRunDir: replayBinding.sourceRunDir,
      });
    }
    return await new WorkflowExecutableRuntime({
      workflow,
      invocation: snapshot,
      database,
      authority,
      products,
      candidates,
      resources,
      ...(workflow.operations.some(operation => operation.method === "agent") ? { agent } : {}),
      ...(workflow.operations.some(operation => operation.method === "command") ? { command } : {}),
      ...(workflow.operations.some(operation => operation.method === "ask") ? { ask } : {}),
      ...(workflow.operations.some(operation => operation.method === "verify") ? { verification } : {}),
      ...(workflow.operations.some(operation => operation.method === "apply") ? { apply } : {}),
      ...(metrics ? { metrics } : {}),
      ...(workflow.operations.some(operation => operation.method === "measure") && metrics ? {
        measurement: {
          executor: commandExecutor,
          environment,
          launchWorkspace: { root: projectRoot, cwd: projectCwd, treeHash: manifest.treeHash },
        },
      } : {}),
      ...(replay ? { replay } : {}),
      ...(signal ? { signal } : {}),
    }).run();
  } finally {
    replay?.close();
    await protocol.close();
  }
}

async function readCanonical<T>(file: string): Promise<T> {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error(`Unsafe prepared workflow context file ${file}`);
  }
  const source = await fs.promises.readFile(file, "utf8");
  const value = JSON.parse(source) as T;
  if (source !== `${stableJson(value)}\n`) throw new Error(`Prepared workflow context is noncanonical: ${file}`);
  return value;
}

async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return await readCanonical<T>(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
