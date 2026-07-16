import fs from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import {
  RunDatabase,
  RunDatabaseReader,
  RunRevisionConflictError,
} from "../persistence/run-database.js";
import {
  assertWorkflowCallChain,
  buildWorkflowCallKey,
} from "../persistence/workflow-journal.js";
import type {
  ArtifactRecord,
  OperationRecord,
  RunRecord,
  WorkflowCallRecord,
} from "./durable-types.js";
import type {
  SemanticEffectJournalIdentity,
  SemanticReplaySource,
} from "./semantic-engine-types.js";
import { stableHash } from "../utils/hashes.js";

const MAX_REVISION_RETRIES = 16;
const MAX_JOURNAL_CALLS = 50_000;

export interface PreparedReplayHit {
  source: SemanticReplaySource;
  artifactRecords: ArtifactRecord[];
  matchedCalls: number;
}

/** One explicit old-run prefix. No run directory is ever searched implicitly. */
export class JournalPrefixReplay implements Disposable {
  private readonly source: RunDatabaseReader;
  private readonly sourceRun: RunRecord;
  private readonly calls: WorkflowCallRecord[];
  private readonly operations: Map<string, OperationRecord>;
  private readonly artifacts: ArtifactStore;
  private cursor: number;
  private disabled: boolean;
  private tail: Promise<void> = Promise.resolve();
  private readonly settledScopes = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private closed = false;

  private constructor(
    readonly targetRunDir: string,
    readonly sourceRunDir: string,
    private readonly database: RunDatabase,
    source: RunDatabaseReader,
  ) {
    this.source = source;
    this.sourceRun = source.readRun();
    this.calls = readAllWorkflowCalls(source);
    this.operations = new Map(this.calls.map((call) => {
      const operation = source.readOperation(call.operationId);
      if (!operation) throw new Error(`Replay source is missing operation ${call.operationId}`);
      return [call.operationId, operation];
    }));
    assertWorkflowCallChain(this.calls, this.operations);
    this.artifacts = new ArtifactStore(targetRunDir, database, {
      maximumArtifactBytes: database.readRun().safety.outputBytes,
    });
    const replay = database.readRun().replay!;
    this.cursor = replay.matchedCalls;
    this.disabled = replay.fresh || replay.firstMissOrdinal !== undefined;
    this.assertDurablePrefix();
  }

  static open(
    targetRunDirInput: string,
    database: RunDatabase,
    sourceRunDirInput: string | undefined,
  ): JournalPrefixReplay | undefined {
    const target = database.readRun();
    const replay = target.replay;
    if (
      !replay
      || replay.mode !== "cross-revision-prefix"
      || replay.fresh
      || replay.firstMissOrdinal !== undefined
      || target.status === "completed"
      || target.status === "failed"
      || target.status === "stopped"
    ) return undefined;
    if (!sourceRunDirInput) throw new Error("Cross-revision replay requires its explicit source run directory");
    const targetRunDir = path.resolve(targetRunDirInput);
    const sourceRunDir = path.resolve(sourceRunDirInput);
    if (targetRunDir === sourceRunDir) throw new Error("Cross-revision replay source is the target run");
    const sourceRoot = fs.lstatSync(sourceRunDir);
    const sourceDatabase = fs.lstatSync(path.join(sourceRunDir, "run.sqlite"));
    if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink() || fs.realpathSync(sourceRunDir) !== sourceRunDir) {
      throw new Error("Replay source run directory is unsafe");
    }
    if (!sourceDatabase.isFile() || sourceDatabase.isSymbolicLink()) {
      throw new Error("Replay source database is unsafe");
    }
    const source = RunDatabaseReader.open(path.join(sourceRunDir, "run.sqlite"));
    try {
      const sourceRun = source.readRun();
      if (sourceRun.runId !== replay.sourceRunId || path.basename(sourceRunDir) !== sourceRun.runId) {
        throw new Error("Replay source directory and durable source run id differ");
      }
      return new JournalPrefixReplay(targetRunDir, sourceRunDir, database, source);
    } catch (error) {
      source.close();
      throw error;
    }
  }

  async consume<T>(
    operation: OperationRecord,
    identity: SemanticEffectJournalIdentity,
    commit: (hit: PreparedReplayHit) => Promise<T>,
  ): Promise<T | undefined> {
    while (true) {
      const decision = await this.exclusive(async (): Promise<
        | { kind: "live" }
        | { kind: "wait"; changed: Promise<void> }
        | { kind: "hit"; value: T }
      > => {
        if (this.disabled) return { kind: "live" };
        const call = this.calls[this.cursor];
        if (!call) {
          await this.miss(operation.ordinal, "source journal prefix ended");
          return { kind: "live" };
        }
        const sourceOperation = this.operations.get(call.operationId)!;
        const mismatch = replayMismatch(operation, identity, sourceOperation, call);
        if (mismatch) {
          if (
            concurrentBranchOrder(sourceOperation.path, operation.path)
            && !this.sourcePathWasSettled(sourceOperation.path)
          ) return { kind: "wait", changed: this.changed() };
          await this.miss(call.ordinal, mismatch);
          return { kind: "live" };
        }
        const workspaceCheckpoint = call.postWorkspaceCheckpointId
          ? this.source.readWorkspaceCheckpoint(call.postWorkspaceCheckpointId)
          : undefined;
        if (call.replayPolicy === "workspace") {
          if (!workspaceCheckpoint || workspaceCheckpoint.operationId !== sourceOperation.operationId) {
            await this.miss(call.ordinal, "source mutation has no exact restorable checkpoint");
            return { kind: "live" };
          }
          if (stableHash(workspaceCheckpoint.workspace) !== stableHash(call.result.workspace)) {
            await this.miss(call.ordinal, "source mutation checkpoint is ambiguous");
            return { kind: "live" };
          }
        }
        const artifactRecords: ArtifactRecord[] = [];
        for (const ref of call.result.artifacts) {
          const sourceArtifact = this.source.readArtifact(ref.digest);
          if (!sourceArtifact || !sameArtifactRef(sourceArtifact, ref)) {
            await this.miss(call.ordinal, `source artifact ${ref.digest} is missing or changed`);
            return { kind: "live" };
          }
          const imported = await this.artifacts.prepareImport(this.sourceRunDir, sourceArtifact);
          if (imported.record) artifactRecords.push(imported.record);
        }
        const result = await commit({
          source: {
            runDir: this.sourceRunDir,
            run: this.sourceRun,
            operation: sourceOperation,
            call,
            ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
          },
          artifactRecords,
          matchedCalls: this.cursor + 1,
        });
        this.cursor++;
        this.wake();
        return { kind: "hit", value: result };
      });
      if (decision.kind === "live") return undefined;
      if (decision.kind === "hit") return decision.value;
      await decision.changed;
    }
  }

  settleStructuralScope(operationPath: string): void {
    if (this.disabled || this.closed) return;
    this.settledScopes.add(operationPath);
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    this.source.close();
  }

  [Symbol.dispose](): void { this.close(); }

  private async miss(ordinal: number, reason: string): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.replay?.firstMissOrdinal !== undefined) {
        this.disabled = true;
        this.wake();
        return;
      }
      try {
        this.database.recordReplayMiss(run.revision, ordinal, reason, new Date().toISOString());
        this.disabled = true;
        this.wake();
        return;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not persist replay prefix miss after repeated revision races");
  }

  private sourcePathWasSettled(sourcePath: string): boolean {
    for (const scope of this.settledScopes) {
      if (sourcePath === scope || sourcePath.startsWith(`${scope}/`)) return true;
    }
    return false;
  }

  private changed(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  private assertDurablePrefix(): void {
    if (this.cursor > this.calls.length) throw new Error("Replay matched-call count exceeds its source journal");
    const targetCalls = readAllWorkflowCalls(this.database);
    const replayed = targetCalls.filter((call) => this.database.readOperation(call.operationId)?.replay);
    if (replayed.length !== this.cursor) throw new Error("Replay prefix count differs from target operation evidence");
    for (let index = 0; index < replayed.length; index++) {
      const targetOperation = this.database.readOperation(replayed[index]!.operationId)!;
      const evidence = targetOperation.replay!;
      const sourceCall = this.calls[index]!;
      if (
        evidence.sourceRunId !== this.sourceRun.runId
        || evidence.sourceOperationId !== sourceCall.operationId
        || evidence.ordinal !== sourceCall.ordinal
        || evidence.callKey !== sourceCall.callKey
      ) throw new Error("Target replay prefix differs from its explicit source journal");
    }
  }

  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (this.closed) throw new Error("Replay prefix reader is closed");
      return await body();
    } finally {
      release();
    }
  }
}

function replayMismatch(
  target: OperationRecord,
  identity: SemanticEffectJournalIdentity,
  source: OperationRecord,
  call: WorkflowCallRecord,
): string | undefined {
  if (source.status !== "completed" || !source.result || stableHash(source.result) !== stableHash(call.result)) {
    return "source call is incomplete or its result is inconsistent";
  }
  if (
    target.path !== source.path
    || target.sourceId !== source.sourceId
    || target.kind !== source.kind
    || target.semanticInputHash !== source.semanticInputHash
  ) return `operation identity changed before ${source.path}`;
  if (identity.semanticKey !== call.semanticKey) return `semantic call key changed at ${source.path}`;
  if (identity.completionAuthority !== call.completionAuthority) return `completion authority changed at ${source.path}`;
  if (identity.replayPolicy !== call.replayPolicy) return `replay policy changed at ${source.path}`;
  if (source.kind === "agent" && call.completionAuthority !== "finish-work") {
    return `source agent ${source.path} has no finish_work authority`;
  }
  if (source.kind === "apply" || call.replayPolicy === "never") return `effect ${source.path} is not replayable`;
  if (call.replayPolicy === "workspace" && (!call.result.workspace || !call.postWorkspaceCheckpointId)) {
    return `source mutation ${source.path} has ambiguous post-state`;
  }
  if (call.replayPolicy === "immutable" && (call.result.workspace || call.postWorkspaceCheckpointId)) {
    return `source immutable call ${source.path} unexpectedly mutated a workspace`;
  }
  const targetCallKey = buildWorkflowCallKey({
    previousJournalKey: call.previousJournalKey,
    operation: target,
    semanticKey: identity.semanticKey,
  });
  if (targetCallKey !== call.callKey) return `journal chain changed at ${source.path}`;
  return undefined;
}

function readAllWorkflowCalls(reader: RunDatabaseReader): WorkflowCallRecord[] {
  const calls: WorkflowCallRecord[] = [];
  let afterOrdinal = -1;
  while (true) {
    const page = reader.listWorkflowCalls({ afterOrdinal, limit: 256 });
    calls.push(...page);
    if (calls.length > MAX_JOURNAL_CALLS) throw new Error("Workflow journal exceeds its safety bound");
    if (page.length < 256) return calls;
    afterOrdinal = page.at(-1)!.ordinal;
  }
}

function sameArtifactRef(record: ArtifactRecord, ref: WorkflowCallRecord["result"]["artifacts"][number]): boolean {
  return record.digest === ref.digest && record.kind === ref.kind
    && record.mediaType === ref.mediaType && record.bytes === ref.bytes;
}

/** True only for two different deterministic lanes of one structured group. */
function concurrentBranchOrder(expectedPath: string, currentPath: string): boolean {
  const expected = expectedPath.split("/");
  const current = currentPath.split("/");
  const length = Math.min(expected.length, current.length);
  for (let index = 0; index < length; index++) {
    if (expected[index] === current[index]) continue;
    const expectedLane = /^(?:branch|item):/.test(expected[index]!);
    const currentLane = /^(?:branch|item):/.test(current[index]!);
    return expectedLane && currentLane;
  }
  return false;
}
