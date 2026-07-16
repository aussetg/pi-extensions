import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { createOpaqueCandidateRef, describeOpaqueCandidateRef } from "../src/candidates/refs.js";
import { candidateAuthorityBinding, measurementDispositionBinding } from "../src/candidates/disposition.js";
import { scanCandidateTree } from "../src/candidates/tree.js";
import type { HostCommandExecutor, HostCommandRequest, HostCommandResult } from "../src/commands/executor.js";
import { resolveCommandInvocation } from "../src/commands/profiles.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { SemanticExperimentAdapter } from "../src/experiments/adapter.js";
import { SemanticMeasurementAdapter } from "../src/measurements/adapter.js";
import { StaticMeasurementEnvironmentProvider } from "../src/measurements/environment.js";
import { createMetricHandle } from "../src/measurements/metrics.js";
import { normalizeMeasurementProfile, type MeasurementProfileDefinition, type MeasurementProfileSnapshot } from "../src/measurements/profiles.js";
import type { HostPressureProvider } from "../src/measurements/pressure.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type { RunRecord } from "../src/runtime/durable-types.js";
import {
  executeSequentialSemanticRun,
  semanticInvocationHash,
  SemanticEngineCrashError,
  type SemanticEffectAdapter,
  type SemanticEffectRequest,
  type SemanticEngineInvocation,
  type SequentialSemanticEngineOptions,
} from "../src/runtime/semantic-engine.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SQLite measurement cohorts", () => {
  it("commits grouped samples, metric state, cgroup statistics, host PSI, and artifacts", async () => {
    const fixture = await createFixture(groupedBody());
    const executor = new ScriptedMeasurementExecutor([
      protocol({ speed: 1, memory: 50 }, 0),
      protocol({ speed: 10, memory: 55 }, 1),
      protocol({ speed: 14, memory: 60 }, 2),
    ]);
    const pressure = new SequencedPressure();
    const outcome = await fixture.execute([
      fixture.measurementAdapter(executor, pressure),
    ]);

    expect(outcome).toMatchObject({
      status: "completed",
      result: { speed: 12, memory: 60, speedSummary: { baseline: 12, current: 12, best: 12, observationCount: 1 } },
    });
    expect(executor.requests).toHaveLength(3);
    expect(executor.requests.every((request) => request.unitKind === "measurement" && request.physicalCoreAffinity === 1)).toBe(true);
    const record = fixture.database.listMeasurements()[0]!;
    expect(record).toMatchObject({
      profileId: "project:bench",
      sampling: { warmups: 1, samples: 2 },
      cpuAffinity: { physicalCores: 1 },
      workspace: { kind: "snapshot", treeHash: fixture.launchTreeHash },
    });
    expect(record.samples).toHaveLength(3);
    expect(record.samples[1]).toMatchObject({
      kind: "sample",
      cgroup: { cpu: { usageUsec: 102 } },
      hostPressure: { marker: 2, cpu: { some: { avg10: 0.2 } } },
    });
    expect(record.diagnostics).toEqual([
      { sample: 0, data: { marker: 1 } },
      { sample: 1, data: { marker: 2 } },
    ]);
    expect(record.diagnosticsArtifact?.kind).toBe("measurement-diagnostics");
    expect(record.cohortArtifact.kind).toBe("measurement-cohort");
    expect(fixture.database.readAttempt(record.attemptId!)).toMatchObject({
      status: "completed",
      effect: "measurement",
      resources: { cpuUsec: 306, memoryPeakBytes: 1_027, cpuPressure: 0.3 },
    });
    expect(fixture.database.readMetric("speed")).toMatchObject({
      role: "primary", baseline: 12, current: 12, best: 12, observationCount: 1,
    });
    expect(fixture.database.readMetric("memory")).toMatchObject({
      role: "guardrail", baseline: 60, current: 60, best: 60, observationCount: 1,
    });
  });

  it("keeps ambient pressure diagnostic while preserving one stable comparison binding", async () => {
    const fixture = await createFixture(`
      const score = flow.metric("score", {
        direction: "maximize",
        primary: true,
        sampling: { warmups: 0, samples: 1, aggregate: "median" },
      });
      const first = await flow.measure("first", { metric: score, measurement: "project:bench", output: "speed" });
      const second = await flow.measure("second", { metric: score, measurement: "project:bench", output: "speed" });
      return { first: first.observation.value, second: second.observation.value, count: score.summary().observationCount };
    `);
    const executor = new ScriptedMeasurementExecutor([
      protocol({ speed: 10, memory: 50 }, 1),
      protocol({ speed: 11, memory: 50 }, 2),
    ]);
    const outcome = await fixture.execute([fixture.measurementAdapter(executor, new SequencedPressure())]);
    expect(outcome).toMatchObject({ status: "completed", result: { first: 10, second: 11, count: 2 } });

    const [first, second] = fixture.database.listMeasurements();
    expect(first!.bindingHash).toBe(second!.bindingHash);
    expect(first!.environmentHash).toBe(second!.environmentHash);
    expect(first!.samples[0]!.hostPressure).not.toEqual(second!.samples[0]!.hostPressure);
    expect(fixture.database.readMetric("score")).toMatchObject({ baseline: 10, current: 11, best: 10 });
  });

  it("restores a committed cohort after a crash without launching another sample", async () => {
    const fixture = await createFixture(singleBody());
    const executor = new ScriptedMeasurementExecutor([protocol({ speed: 7, memory: 1 }, 1)]);
    let crash = true;
    await expect(fixture.execute([fixture.measurementAdapter(executor)], {
      faultInjector: (point) => {
        if (point === "after-operation-completion" && crash) {
          crash = false;
          throw new SemanticEngineCrashError("power loss after measurement commit");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);
    expect(executor.requests).toHaveLength(1);
    expect(fixture.database.listMeasurements()).toHaveLength(1);

    const completed = await fixture.execute([
      fixture.measurementAdapter(new ScriptedMeasurementExecutor([])),
    ]);
    expect(completed).toMatchObject({ status: "completed", result: { value: 7, count: 1 } });
    expect(fixture.database.listMeasurements()).toHaveLength(1);
  });

  it("replays an exact cross-revision cohort and imports its SQLite/artifact evidence", async () => {
    const source = await createFixture(singleBody());
    const sourceExecutor = new ScriptedMeasurementExecutor([protocol({ speed: 21, memory: 1 }, 1)]);
    expect(await source.execute([source.measurementAdapter(sourceExecutor)])).toMatchObject({ status: "completed" });
    const sourceRecord = source.database.listMeasurements()[0]!;

    const target = await createFixture(singleBody(), { replaySourceRunId: source.runId });
    const targetExecutor = new ScriptedMeasurementExecutor([]);
    const replayed = await target.execute([target.measurementAdapter(targetExecutor)], {
      replaySourceRunDir: source.runDir,
    });
    expect(replayed).toMatchObject({ status: "completed", result: { value: 21, count: 1 } });
    expect(targetExecutor.requests).toEqual([]);
    const targetRecord = target.database.listMeasurements()[0]!;
    expect(targetRecord.measurementId).toBe(sourceRecord.measurementId);
    expect(targetRecord.bindingHash).toBe(sourceRecord.bindingHash);
    expect(targetRecord.attemptId).toBeUndefined();
    expect(target.database.listOperations({ limit: 4 })[0]!.replay).toMatchObject({ sourceRunId: source.runId });
    expect(target.database.readArtifact(targetRecord.cohortArtifact.digest)).toBeDefined();
  });

  it("changes binding and journal identity for candidate tree, profile, or sampling changes", async () => {
    const fixture = await createFixture(singleBody());
    const baseAdapter = fixture.measurementAdapter(new ScriptedMeasurementExecutor([]));
    const base = await admissionIdentity(baseAdapter, fixture, {
      metric: metric("score", 1), measurement: "project:bench", output: "speed",
    });
    const same = await admissionIdentity(fixture.measurementAdapter(new ScriptedMeasurementExecutor([])), fixture, {
      metric: metric("score", 1), measurement: "project:bench", output: "speed",
    });
    expect(same.semanticKey).toBe(base.semanticKey);

    const changedSampling = await admissionIdentity(fixture.measurementAdapter(new ScriptedMeasurementExecutor([])), fixture, {
      metric: metric("score", 2), measurement: "project:bench", output: "speed",
    });
    expect(changedSampling.semanticKey).not.toBe(base.semanticKey);

    const changedProfile = profile({ argv: ["/usr/bin/printf", "changed"] });
    const profileAdapter = fixture.measurementAdapter(new ScriptedMeasurementExecutor([]), undefined, [changedProfile]);
    const profileIdentity = await admissionIdentity(profileAdapter, fixture, {
      metric: metric("score", 1), measurement: "project:bench", output: "speed",
    });
    expect(profileIdentity.semanticKey).not.toBe(base.semanticKey);

    const candidate = await fixture.createCandidate("changed candidate");
    const candidateIdentity = await admissionIdentity(fixture.measurementAdapter(new ScriptedMeasurementExecutor([])), fixture, {
      metric: metric("score", 1), measurement: "project:bench", output: "speed", workspace: candidate,
    });
    expect(candidateIdentity.semanticKey).not.toBe(base.semanticKey);
  });

  it("rejects grouped policy mismatches before launching a command", async () => {
    const fixture = await createFixture(`
      const speed = flow.metric("speed", { direction: "maximize", sampling: { warmups: 0, samples: 1, aggregate: "median" } });
      const memory = flow.metric("memory", { direction: "minimize", sampling: { warmups: 0, samples: 2, aggregate: "max" } });
      await flow.measure("bad", { measurement: "project:bench", metrics: { speed, memory } });
      return { unreachable: true };
    `);
    const executor = new ScriptedMeasurementExecutor([]);
    const failed = await fixture.execute([fixture.measurementAdapter(executor)]);
    expect(failed).toMatchObject({ status: "failed" });
    expect((failed as { error?: string }).error).toMatch(/share warmup and sample counts/i);
    expect(executor.requests).toEqual([]);
    expect(fixture.database.listMeasurements()).toEqual([]);
  });
});

describe("SQLite experiment records", () => {
  it("binds one record to the exact candidate, measurement, and completed disposition", async () => {
    const fixture = await createFixture(`
      const score = flow.metric("score", {
        direction: "maximize",
        primary: true,
        sampling: { warmups: 0, samples: 1, aggregate: "median" },
        improvement: { minimumAbsolute: 1 },
      });
      await flow.measure("baseline", { metric: score, measurement: "project:bench", output: "speed" });
      const measured = await flow.measure("candidate-measure", {
        metric: score, measurement: "project:bench", output: "speed", workspace: flow.snapshot,
      });
      await flow.reject("reject", {
        candidate: flow.snapshot, measurement: measured, reason: "not enough",
      });
      return await flow.recordExperiment("record", {
        candidate: {
          candidate: flow.snapshot,
          metadata: {
            hypothesis: "Make the hot path shorter",
            changeSummary: "Changed one branch",
            expectedEffect: "Higher throughput",
            nextFocus: "Allocation count",
          },
        },
        measurement: measured,
        learned: "The branch was still slower",
      });
    `, { snapshot: true });
    const candidate = await fixture.createCandidate("candidate source");
    const executor = new ScriptedMeasurementExecutor([
      protocol({ speed: 10, memory: 1 }, 0),
      protocol({ speed: 9, memory: 1 }, 1),
    ]);
    const adapters = [
      fixture.measurementAdapter(executor),
      dispositionAdapter("reject"),
      new SemanticExperimentAdapter({ runDir: fixture.runDir, database: fixture.database }),
    ];
    const outcome = await fixture.execute(adapters, { snapshot: candidate });
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        disposition: "rejected",
        hypothesis: "Make the hot path shorter",
        primary: { metricId: "score", value: 9, relativeChange: -0.1 },
        learned: "The branch was still slower",
      },
    });
    const experiment = fixture.database.listExperiments()[0]!;
    const candidateMeasurement = fixture.database.listMeasurements().find((entry) => entry.candidateId)!;
    const disposition = fixture.database.listOperations({ limit: 32 }).find((entry) => entry.kind === "reject")!;
    expect(experiment).toMatchObject({
      candidateId: candidateId(candidate),
      measurementId: candidateMeasurement.measurementId,
      dispositionOperationId: disposition.operationId,
      disposition: "rejected",
      recordArtifact: { kind: "experiment-record" },
    });
    expect(experiment.bindingHash).toMatch(/^sha256:/);
    expect(fixture.database.readExperiment(experiment.experimentId)).toEqual(experiment);
  });

  it("refuses a disposition that names another measurement", async () => {
    const fixture = await createFixture(`
      const score = flow.metric("score", {
        direction: "maximize",
        sampling: { warmups: 0, samples: 1, aggregate: "median" },
      });
      const measured = await flow.measure("launch-measure", {
        metric: score, measurement: "project:bench", output: "speed",
      });
      await flow.reject("reject", { candidate: flow.snapshot, measurement: measured, reason: "wrong evidence" });
      return await flow.recordExperiment("record", {
        candidate: {
          candidate: flow.snapshot,
          metadata: {
            hypothesis: "Mismatch",
            changeSummary: "No measured change",
            expectedEffect: "None",
            nextFocus: "Correct evidence",
          },
        },
        measurement: measured,
        learned: "The launch cohort cannot prove a candidate result",
      });
    `, { snapshot: true });
    const candidate = await fixture.createCandidate("candidate");
    const executor = new ScriptedMeasurementExecutor([protocol({ speed: 10, memory: 1 }, 0)]);
    const failed = await fixture.execute([
      fixture.measurementAdapter(executor),
      dispositionAdapter("reject"),
      new SemanticExperimentAdapter({ runDir: fixture.runDir, database: fixture.database }),
    ], { snapshot: candidate });
    expect(failed).toMatchObject({ status: "failed" });
    expect((failed as { error?: string }).error).toMatch(/measurement is not bound to its candidate/i);
    expect(fixture.database.listExperiments()).toEqual([]);
  });
});

interface FixtureOptions { snapshot?: boolean; replaySourceRunId?: string }

async function createFixture(body: string, options: FixtureOptions = {}) {
  const source = workflowSource(body, options.snapshot === true);
  const parsed = parseStructuredWorkflow(source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-measurement-"));
  roots.push(root);
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  const launchRoot = path.join(runDir, "context", "project");
  fs.mkdirSync(launchRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(launchRoot, "fixture.txt"), "launch\n");
  const launchTreeHash = (await scanCandidateTree(launchRoot)).treeHash;
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const invocation: SemanticEngineInvocation = {
    workflowId: "builtin:measurement-fixture",
    definitionHash,
    input: {},
    inputHash: stableHash({}),
  };
  const createdAt = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:measurement-fixture",
      name: parsed.metadata.name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: launchTreeHash,
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "queued",
    safety: {
      concurrency: 1,
      maximumAgentLaunches: 32,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 100,
      cpuWeight: 100,
      outputBytes: 16 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    ...(options.replaySourceRunId ? {
      replay: {
        mode: "cross-revision-prefix" as const,
        sourceRunId: options.replaySourceRunId,
        matchedCalls: 0,
        fresh: false,
      },
    } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  const defaultProfile = profile();
  const environment = new StaticMeasurementEnvironmentProvider({ host: "fixed", cpu: "test" });
  const launchWorkspace = {
    root: launchRoot,
    cwd: launchRoot,
    workspace: {
      kind: "snapshot" as const,
      workspaceId: `snapshot_${"1".repeat(32)}`,
      treeHash: launchTreeHash,
    },
  };
  return {
    runId, runDir, database, parsed, invocation, launchTreeHash,
    measurementAdapter: (
      executor: HostCommandExecutor,
      pressure: HostPressureProvider = new SequencedPressure(),
      profiles: readonly MeasurementProfileSnapshot[] = [defaultProfile],
    ) => new SemanticMeasurementAdapter({
      runDir, database, profiles, environment, executor, launchWorkspace, pressure,
    }),
    execute: (
      adapters: readonly SemanticEffectAdapter[],
      engineOptions: SequentialSemanticEngineOptions = {},
    ) => executeSequentialSemanticRun(runDir, database, parsed, invocation, adapters, {
      controlPollIntervalMs: 5,
      ...engineOptions,
    }),
    createCandidate: async (content: string) => {
      const workspaceId = `workspace_${crypto.randomBytes(16).toString("hex")}`;
      const candidateRoot = path.join(runDir, "workspaces", "candidates", workspaceId, "project");
      fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(candidateRoot, "fixture.txt"), `${content}\n`);
      const tree = await scanCandidateTree(candidateRoot);
      const lineageHash = stableHash({ launchTreeHash, workspaceId });
      const writeScope = "all-semantic-project-paths" as const;
      const writeScopeHash = stableHash(writeScope);
      const artifacts = new ArtifactStore(runDir, database);
      const manifest = await artifacts.putJson({
        expectedRevision: database.readRun().revision,
        kind: "candidate-manifest",
        value: { treeHash: tree.treeHash },
        metadata: {},
      });
      const diff = await artifacts.putJson({
        expectedRevision: database.readRun().revision,
        kind: "candidate-diff",
        value: { changed: ["fixture.txt"] },
        metadata: {},
      });
      database.registerCandidateWorkspace(database.readRun().revision, {
        workspaceId,
        runId,
        logicalId: "experiment-workspace",
        workspace: { kind: "candidate", workspaceId, treeHash: tree.treeHash, lineageHash, writeScopeHash },
        writeScope,
        rootPath: `workspaces/candidates/${workspaceId}/project`,
        createdAt: new Date().toISOString(),
      }, { type: "candidate-workspace-fixture", payload: { workspaceId }, at: new Date().toISOString() });
      const id = `candidate_${stableHash({ runId, workspaceId, treeHash: tree.treeHash }).slice(7, 39)}`;
      database.registerCandidate(database.readRun().revision, {
        candidateId: id,
        runId,
        workspace: { kind: "candidate", workspaceId, treeHash: tree.treeHash, lineageHash, writeScopeHash },
        changedPaths: ["fixture.txt"],
        manifest: manifest.artifact,
        diff: diff.artifact,
        frozenAt: new Date().toISOString(),
      }, { type: "candidate-fixture", payload: { candidateId: id }, at: new Date().toISOString() });
      return createOpaqueCandidateRef({
        runId,
        candidateId: id,
        logicalPath: "run/loop:experiments/iteration:0/candidate:attempt",
        committedAttempt: 1,
        treeHash: tree.treeHash,
        lineageHash,
        recordHash: stableHash({ id, treeHash: tree.treeHash }),
      });
    },
  };
}

function workflowSource(body: string, snapshot: boolean): string {
  return `
export default defineWorkflow({
  name: "measurement-fixture",
  description: "SQLite measurement fixture.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object" },
  capabilities: ["read-project", "host-command"${snapshot ? ", \"candidate-write\"" : ""}],
  modelVisible: false,
  maxParallelism: 1,
  async run(flow, args) {
    void args;
    ${body}
  },
});
`;
}

function groupedBody(): string {
  return `
    const speed = flow.metric("speed", {
      direction: "maximize", primary: true,
      sampling: { warmups: 1, samples: 2, aggregate: "mean" },
    });
    const memory = flow.metric("memory", {
      direction: "minimize",
      sampling: { warmups: 1, samples: 2, aggregate: "max" },
      guardrail: { reference: "baseline", maximumAbsoluteRegression: 10 },
    });
    const measured = await flow.measure("baseline", {
      measurement: "project:bench", metrics: { speed, memory },
    });
    return {
      speed: measured.observations.speed.value,
      memory: measured.observations.memory.value,
      speedSummary: speed.summary(),
    };
  `;
}

function singleBody(): string {
  return `
    const score = flow.metric("score", {
      direction: "maximize",
      sampling: { warmups: 0, samples: 1, aggregate: "median" },
    });
    const measured = await flow.measure("once", {
      metric: score, measurement: "project:bench", output: "speed",
    });
    return { value: measured.observation.value, count: score.summary().observationCount };
  `;
}

function profile(overrides: Partial<MeasurementProfileDefinition> = {}): MeasurementProfileSnapshot {
  const definition = normalizeMeasurementProfile({
    name: "bench",
    description: "Test benchmark",
    argv: ["/usr/bin/printf", "fixture"],
    timeoutMs: 10_000,
    cpuAffinity: { physicalCores: 1 },
    outputs: {
      memory: { extract: { kind: "protocol" } },
      speed: { extract: { kind: "protocol" } },
    },
    diagnostics: {
      extract: { kind: "protocol" },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["marker"],
        properties: { marker: { type: "integer", minimum: 0 } },
      },
    },
    ...overrides,
  });
  return {
    ...definition,
    id: "project:bench",
    namespace: "project",
    path: "/fixture/.pi/measurements/bench.json",
    hash: stableHash({ namespace: "project", definition }),
  };
}

function metric(id: string, samples: number) {
  return createMetricHandle(id, {
    direction: "maximize",
    sampling: { warmups: 0, samples, aggregate: "median" },
  });
}

async function admissionIdentity(
  adapter: SemanticMeasurementAdapter,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Record<string, unknown>,
) {
  const request = {
    run: fixture.database.readRun(),
    kind: "measure" as const,
    sourceId: "probe",
    path: "run/measure:probe",
    input,
  };
  await adapter.semanticInput(request);
  return await adapter.journalIdentity(request);
}

class ScriptedMeasurementExecutor implements HostCommandExecutor {
  readonly requests: HostCommandRequest[] = [];
  constructor(private readonly outputs: string[]) {}
  describe() { return { id: "measurement-test", protocolVersion: 1 as const, sandbox: "fake" as const }; }
  async execute(request: HostCommandRequest): Promise<HostCommandResult> {
    const stdout = this.outputs[this.requests.length];
    if (stdout === undefined) throw new Error(`No scripted output for measurement call ${this.requests.length}`);
    this.requests.push(request);
    const invocation = resolveCommandInvocation(request.profile, request.arguments, request.effect);
    const index = this.requests.length;
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const endedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index, 1)).toISOString();
    const out = Buffer.from(stdout);
    const err = Buffer.alloc(0);
    return {
      status: "completed",
      exitCode: 0,
      timedOut: false,
      stdout: out,
      stderr: err,
      stdoutEvidence: { bytes: out.length, digest: sha256(out), inlineBytes: out.length, truncated: false },
      stderrEvidence: { bytes: 0, digest: sha256(err), inlineBytes: 0, truncated: false },
      exitEvidence: { kind: "exit", code: 0 },
      invocation,
      executor: this.describe(),
      startedAt,
      endedAt,
      unit: `pi-workflow-measurement-${"a".repeat(32)}.service`,
      cgroup: "/fixture",
      resources: cgroup(index),
      unitCleaned: true,
    };
  }
}

class SequencedPressure implements HostPressureProvider {
  private count = 0;
  async capture(): Promise<JsonObject> {
    this.count++;
    return { marker: this.count, cpu: { some: { avg10: this.count / 10 } } } as unknown as JsonObject;
  }
}

function dispositionAdapter(kind: "accept" | "reject"): SemanticEffectAdapter {
  const binding = (request: { input: unknown; database: RunDatabase }) => {
    const options = request.input as Record<string, any>;
    const id = candidateId(options.candidate);
    const candidate = request.database.readCandidate(id)!;
    const measurement = request.database.readMeasurement(options.measurement.measurementId)!;
    return {
      disposition: kind === "accept" ? "accepted" : "rejected",
      candidate: candidateAuthorityBinding(candidate),
      measurement: measurementDispositionBinding(measurement),
      ...(options.reason ? { reason: options.reason } : {}),
    };
  };
  return {
    kind,
    semanticInput: ({ input }) => {
      const options = input as Record<string, any>;
      return {
        candidateId: candidateId(options.candidate),
        measurementId: options.measurement.measurementId,
        ...(options.reason ? { reason: options.reason } : {}),
      } as JsonValue;
    },
    journalIdentity: ({ input, run }) => ({
      semanticKey: stableHash({ input, context: run.contextIdentityHash }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    }),
    execute: async (request: SemanticEffectRequest) => {
      return {
        result: {
          value: binding(request) as unknown as JsonValue,
          artifacts: [],
        },
        completionAuthority: "host-effect" as const,
      };
    },
  };
}

function candidateId(value: unknown): string {
  const descriptor = describeOpaqueCandidateRef(value);
  if (!descriptor) throw new Error("Expected candidate ref");
  return descriptor.candidateId;
}

function protocol(values: { speed: number; memory: number }, marker: number): string {
  return [
    JSON.stringify({ type: "metric", id: "memory", value: values.memory }),
    JSON.stringify({ type: "metric", id: "speed", value: values.speed }),
    JSON.stringify({ type: "diagnostic", data: { marker } }),
    "",
  ].join("\n");
}

function cgroup(index: number) {
  const pressure = { some: { avg10: index / 10, avg60: 0, avg300: 0, totalUsec: index } };
  return {
    sampledAt: new Date().toISOString(),
    controlGroup: "/fixture",
    cpu: { usageUsec: 100 + index, userUsec: 80, systemUsec: 20, throttledUsec: 0, throttledPeriods: 0, pressure },
    io: { readBytes: index, writeBytes: index * 2, readOperations: 1, writeOperations: 1, pressure },
    memory: { currentBytes: 512, peakBytes: 1_024 + index, oomEvents: 0, oomKillEvents: 0, pressure },
    pids: { current: 1, peak: 2, limitEvents: 0 },
  };
}

function zeroUsage() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    providerRequests: 0, cost: 0, elapsedMs: 0, complete: true,
  };
}
