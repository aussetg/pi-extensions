import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cloneCandidateTree, scanCandidateTree } from "../src/candidates/tree.js";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import {
  WorkflowRunDatabaseV17,
  type WorkflowOperationV17Record,
  type WorkflowScopeV17Record,
} from "../src/persistence/run-database-v17.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import {
  WORKFLOW_V17_ROOT_SCOPE_SEED,
  workflowV17FreshCallKey,
  workflowV17LaneSeed,
  workflowV17OperationIdentity,
  workflowV17StructuralJoinKey,
} from "../src/runtime/causal-identity-v17.js";
import {
  WorkflowV17CausalReplay,
  WorkflowV17CausalReplayError,
  type WorkflowV17CausalReplayFaultPoint,
} from "../src/runtime/causal-replay-v17.js";
import type { SafetyConfiguration } from "../src/runtime/durable-types.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";

const API = path.resolve("workflow-api.d.ts");
const BASE_TIME = Date.parse("2026-07-01T12:00:00.000Z");
const roots: string[] = [];
const closeables = new Set<{ close(): void }>();

const SIMPLE_SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Replay effects.",
  input: s.object({ value: s.string() }),
  output: s.object({ value: s.string() }),
  async run(_flow, args) { return { value: args.value }; },
});
`;
const SIMPLE_PARSED = parseWorkflowV17(SIMPLE_SOURCE, {
  fileName: "/virtual/simple.flow.ts",
  apiPath: API,
});

afterEach(() => {
  for (const value of closeables) value.close();
  closeables.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 causal replay", () => {
  it("imports exact successful calls while ignoring display/source-site changes", async () => {
    const pair = createPair(
      "user:simple",
      SIMPLE_SOURCE.replace("Replay effects.", "Replay effects after a source revision."),
    );
    expect(pair.source.database.readRun().workflow.definitionHash)
      .not.toBe(pair.target.database.readRun().workflow.definitionHash);
    const source = claim(pair.source.database, pair.source.rootScope, 0, "agent", "same-input", {
      sourceSite: "site-old", title: "Old title",
    });
    const sourceCall = completeFresh(pair.source.database, source, {
      semantic: "same-semantic",
      authority: "finish-work",
      policy: "immutable",
      result: { answer: "source" },
    });

    const target = claim(pair.target.database, pair.target.rootScope, 0, "agent", "same-input", {
      sourceSite: "site-new", title: "Renamed display",
    });
    const replay = await openReplay(pair);
    const decision = await replay.tryReplayCall({
      operationId: target.operationId,
      semanticKey: hash("same-semantic"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    });
    expect(decision).toMatchObject({
      kind: "hit",
      result: { answer: "source" },
      source: { operationId: source.operationId, callKey: sourceCall.callKey },
      workspaceRestored: false,
    });
    expect(pair.target.database.readScopeCall(target.operationId)).toMatchObject({
      callKey: sourceCall.callKey,
      replay: {
        sourceRunId: pair.source.database.readRun().runId,
        sourceOperationId: source.operationId,
      },
    });
    expect(pair.target.database.readOperation(target.operationId)?.result).toEqual({ answer: "source" });
    pair.target.database.validateIntegrity();
  });

  it("ends only the changed sequential lane prefix", async () => {
    const pair = createPair();
    const sourceFirst = claim(pair.source.database, pair.source.rootScope, 0, "command", "old");
    const sourceFirstCall = completeFresh(pair.source.database, sourceFirst, {
      semantic: "first", authority: "host-effect", policy: "immutable", result: { value: 1 },
    });
    const sourceSecond = claim(pair.source.database, pair.source.rootScope, 1, "command", "same-second");
    completeFresh(pair.source.database, sourceSecond, {
      previous: sourceFirstCall.callKey,
      semantic: "second", authority: "host-effect", policy: "immutable", result: { value: 2 },
    });

    const targetFirst = claim(pair.target.database, pair.target.rootScope, 0, "command", "new");
    const replay = await openReplay(pair);
    expect(await replay.tryReplayCall({
      operationId: targetFirst.operationId,
      semanticKey: hash("first"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "miss", code: "operation-changed" });
    const targetFirstCall = completeFresh(pair.target.database, targetFirst, {
      semantic: "first", authority: "host-effect", policy: "immutable", result: { value: 99 },
    });
    const targetSecond = claim(pair.target.database, pair.target.rootScope, 1, "command", "same-second");
    expect(await replay.tryReplayCall({
      operationId: targetSecond.operationId,
      semanticKey: hash("second"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "miss", code: "scope-prefix-changed" });
    expect(targetFirstCall.callKey).not.toBe(sourceFirstCall.callKey);
  });

  it("reconstructs lane-prefix eligibility from SQLite after replay restarts", async () => {
    const pair = createPair();
    const sourceFirst = claim(pair.source.database, pair.source.rootScope, 0, "command", "first");
    const firstCall = completeFresh(pair.source.database, sourceFirst, {
      semantic: "first", authority: "host-effect", policy: "immutable", result: { first: true },
    });
    const sourceSecond = claim(pair.source.database, pair.source.rootScope, 1, "command", "second");
    const secondCall = completeFresh(pair.source.database, sourceSecond, {
      previous: firstCall.callKey,
      semantic: "second", authority: "host-effect", policy: "immutable", result: { second: true },
    });

    const targetFirst = claim(pair.target.database, pair.target.rootScope, 0, "command", "first");
    const firstReplay = await openReplay(pair);
    expect(await firstReplay.tryReplayCall({
      operationId: targetFirst.operationId,
      semanticKey: hash("first"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "hit", source: { callKey: firstCall.callKey } });
    firstReplay.close();
    closeables.delete(firstReplay);

    const targetSecond = claim(pair.target.database, pair.target.rootScope, 1, "command", "second");
    const resumed = await openReplay(pair);
    expect(await resumed.tryReplayCall({
      operationId: targetSecond.operationId,
      semanticKey: hash("second"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "hit", source: { callKey: secondCall.callKey } });
  });

  it("reuses an unchanged sibling lane independently of scheduler completion order", async () => {
    for (const order of [["changed", "stable"], ["stable", "changed"]] as const) {
      const pair = createPair();
      const sourceGroup = createGroup(pair.source.database, "parallel", ["changed", "stable"]);
      const sourceOperations = {
        changed: claim(pair.source.database, sourceGroup.scopes.changed.scopeId, 0, "agent", "old"),
        stable: claim(pair.source.database, sourceGroup.scopes.stable.scopeId, 0, "agent", "stable"),
      };
      const sourceCalls: Record<string, string> = {};
      for (const key of order) {
        const call = completeFresh(pair.source.database, sourceOperations[key], {
          previous: sourceGroup.scopes[key].seedKey,
          semantic: key,
          authority: "finish-work",
          policy: "immutable",
          result: { lane: key },
        });
        sourceCalls[key] = call.callKey;
        completeScope(pair.source.database, sourceGroup.scopes[key], call.callKey);
      }
      completeJoin(pair.source.database, sourceGroup.operation, sourceGroup.scopes, {
        order: ["changed", "stable"],
        terminals: sourceCalls,
        result: { changed: { lane: "changed" }, stable: { lane: "stable" } },
      });
      const sourceDownstream = claim(pair.source.database, pair.source.rootScope, 1, "command", "downstream");
      const sourceGroupCall = pair.source.database.readScopeCall(sourceGroup.operation.operationId)!;
      completeFresh(pair.source.database, sourceDownstream, {
        previous: sourceGroupCall.callKey,
        semantic: "downstream", authority: "host-effect", policy: "immutable", result: { done: true },
      });

      const targetGroup = createGroup(pair.target.database, "parallel", ["changed", "stable"]);
      const changed = claim(pair.target.database, targetGroup.scopes.changed.scopeId, 0, "agent", "new");
      const stable = claim(pair.target.database, targetGroup.scopes.stable.scopeId, 0, "agent", "stable");
      const replay = await openReplay(pair);
      expect(await replay.tryReplayCall({
        operationId: changed.operationId,
        semanticKey: hash("changed"),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      })).toMatchObject({ kind: "miss", code: "operation-changed" });
      const changedCall = completeFresh(pair.target.database, changed, {
        previous: targetGroup.scopes.changed.seedKey,
        semantic: "changed", authority: "finish-work", policy: "immutable", result: { lane: "changed-new" },
      });
      completeScope(pair.target.database, targetGroup.scopes.changed, changedCall.callKey);
      const stableDecision = await replay.tryReplayCall({
        operationId: stable.operationId,
        semanticKey: hash("stable"),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      });
      expect(stableDecision).toMatchObject({ kind: "hit", source: { callKey: sourceCalls.stable } });
      completeScope(pair.target.database, targetGroup.scopes.stable, sourceCalls.stable!);
      const joined = replay.completeStructuralJoin(joinInput(
        targetGroup.operation,
        targetGroup.scopes,
        ["changed", "stable"],
        { changed: changedCall.callKey, stable: sourceCalls.stable! },
        { changed: { lane: "changed-new" }, stable: { lane: "stable" } },
      ));
      expect(joined.replayedSourceJoin).toBe(false);

      const targetDownstream = claim(pair.target.database, pair.target.rootScope, 1, "command", "downstream");
      expect(await replay.tryReplayCall({
        operationId: targetDownstream.operationId,
        semanticKey: hash("downstream"),
        completionAuthority: "host-effect",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      })).toMatchObject({ kind: "miss", code: "scope-prefix-changed" });
    }
  });

  it("reuses keyed map lanes across reorder while the changed join ends the parent prefix", async () => {
    const pair = createPair();
    const sourceGroup = createGroup(pair.source.database, "map", ["a", "b"]);
    const sourceTerminals: Record<string, string> = {};
    for (const key of ["a", "b"]) {
      const operation = claim(pair.source.database, sourceGroup.scopes[key]!.scopeId, 0, "agent", key);
      const call = completeFresh(pair.source.database, operation, {
        previous: sourceGroup.scopes[key]!.seedKey,
        semantic: key, authority: "finish-work", policy: "immutable", result: { key },
      });
      sourceTerminals[key] = call.callKey;
      completeScope(pair.source.database, sourceGroup.scopes[key]!, call.callKey);
    }
    completeJoin(pair.source.database, sourceGroup.operation, sourceGroup.scopes, {
      order: ["a", "b"], terminals: sourceTerminals, result: [{ key: "a" }, { key: "b" }],
    });

    const targetGroup = createGroup(pair.target.database, "map", ["b", "a"]);
    const replay = await openReplay(pair);
    const targetTerminals: Record<string, string> = {};
    for (const key of ["b", "a"]) {
      const operation = claim(pair.target.database, targetGroup.scopes[key]!.scopeId, 0, "agent", key);
      const decision = await replay.tryReplayCall({
        operationId: operation.operationId,
        semanticKey: hash(key),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      });
      expect(decision.kind).toBe("hit");
      targetTerminals[key] = (decision as { source: { callKey: string } }).source.callKey;
      completeScope(pair.target.database, targetGroup.scopes[key]!, targetTerminals[key]!);
    }
    const joined = replay.completeStructuralJoin(joinInput(
      targetGroup.operation,
      targetGroup.scopes,
      ["b", "a"],
      targetTerminals,
      [{ key: "b" }, { key: "a" }],
    ));
    expect(joined.replayedSourceJoin).toBe(false);
  });

  it("keeps existing map lanes eligible when the target adds a new key", async () => {
    const pair = createPair();
    const sourceGroup = createGroup(pair.source.database, "map", ["a"]);
    const sourceA = claim(pair.source.database, sourceGroup.scopes.a.scopeId, 0, "agent", "a");
    const sourceCall = completeFresh(pair.source.database, sourceA, {
      previous: sourceGroup.scopes.a.seedKey,
      semantic: "a", authority: "finish-work", policy: "immutable", result: { key: "a" },
    });
    completeScope(pair.source.database, sourceGroup.scopes.a, sourceCall.callKey);
    completeJoin(pair.source.database, sourceGroup.operation, sourceGroup.scopes, {
      order: ["a"], terminals: { a: sourceCall.callKey }, result: [{ key: "a" }],
    });

    const targetGroup = createGroup(pair.target.database, "map", ["a", "b"]);
    const targetA = claim(pair.target.database, targetGroup.scopes.a.scopeId, 0, "agent", "a");
    const targetB = claim(pair.target.database, targetGroup.scopes.b.scopeId, 0, "agent", "b");
    const replay = await openReplay(pair);
    expect(await replay.tryReplayCall({
      operationId: targetA.operationId,
      semanticKey: hash("a"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "hit", source: { callKey: sourceCall.callKey } });
    expect(await replay.tryReplayCall({
      operationId: targetB.operationId,
      semanticKey: hash("b"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "miss", code: "scope-unavailable" });
  });

  it("continues the parent prefix when every lane and the structural join match", async () => {
    const pair = createPair();
    const sourceGroup = createGroup(pair.source.database, "parallel", ["a"]);
    const sourceLane = claim(pair.source.database, sourceGroup.scopes.a.scopeId, 0, "agent", "a");
    const sourceLaneCall = completeFresh(pair.source.database, sourceLane, {
      previous: sourceGroup.scopes.a.seedKey,
      semantic: "a", authority: "finish-work", policy: "immutable", result: { a: true },
    });
    completeScope(pair.source.database, sourceGroup.scopes.a, sourceLaneCall.callKey);
    const sourceJoin = completeJoin(pair.source.database, sourceGroup.operation, sourceGroup.scopes, {
      order: ["a"], terminals: { a: sourceLaneCall.callKey }, result: { a: { a: true } },
    });
    const sourceAfter = claim(pair.source.database, pair.source.rootScope, 1, "command", "after");
    const sourceAfterCall = completeFresh(pair.source.database, sourceAfter, {
      previous: sourceJoin.callKey,
      semantic: "after", authority: "host-effect", policy: "immutable", result: { after: true },
    });

    const targetGroup = createGroup(pair.target.database, "parallel", ["a"]);
    const targetLane = claim(pair.target.database, targetGroup.scopes.a.scopeId, 0, "agent", "a");
    const replay = await openReplay(pair);
    const lane = await replay.tryReplayCall({
      operationId: targetLane.operationId,
      semanticKey: hash("a"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    });
    expect(lane.kind).toBe("hit");
    completeScope(pair.target.database, targetGroup.scopes.a, sourceLaneCall.callKey);
    const targetJoin = replay.completeStructuralJoin(joinInput(
      targetGroup.operation,
      targetGroup.scopes,
      ["a"],
      { a: sourceLaneCall.callKey },
      { a: { a: true } },
    ));
    expect(targetJoin).toMatchObject({ replayedSourceJoin: true, joinKey: sourceJoin.callKey });
    const targetAfter = claim(pair.target.database, pair.target.rootScope, 1, "command", "after");
    expect(await replay.tryReplayCall({
      operationId: targetAfter.operationId,
      semanticKey: hash("after"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "hit", source: { callKey: sourceAfterCall.callKey } });
  });

  it("never imports failed or explicitly non-replayable effects", async () => {
    const pair = createPair();
    const failed = claim(pair.source.database, pair.source.rootScope, 0, "command", "failed");
    completeFresh(pair.source.database, failed, {
      semantic: "failed", authority: "host-effect", policy: "never",
      outcome: "failure", result: { category: "effect", code: "failed", summary: "failed", retryable: false },
    });
    const targetFailed = claim(pair.target.database, pair.target.rootScope, 0, "command", "failed");
    const replay = await openReplay(pair);
    expect(await replay.tryReplayCall({
      operationId: targetFailed.operationId,
      semanticKey: hash("failed"),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).toMatchObject({ kind: "miss", code: "source-failed" });

    const applyPair = createPair();
    const sourceApply = claim(applyPair.source.database, applyPair.source.rootScope, 0, "apply", "apply");
    completeFresh(applyPair.source.database, sourceApply, {
      semantic: "apply", authority: "host-effect", policy: "never", result: { applied: true },
    });
    const targetApply = claim(applyPair.target.database, applyPair.target.rootScope, 0, "apply", "apply");
    const applyReplay = await openReplay(applyPair);
    expect(await applyReplay.tryReplayCall({
      operationId: targetApply.operationId,
      semanticKey: hash("apply"),
      completionAuthority: "host-effect",
      replayPolicy: "never",
      at: time(applyPair.target.database),
    })).toMatchObject({ kind: "miss", code: "non-replayable" });
  });

  it("imports artifact bodies and links atomically with the replay call", async () => {
    const pair = createPair();
    const source = claim(pair.source.database, pair.source.rootScope, 0, "agent", "artifact");
    const artifact = writeArtifact(pair.source.runDir, pair.source.database, "agent-output", { answer: 42 });
    const sourceCall = completeFresh(pair.source.database, source, {
      semantic: "artifact", authority: "finish-work", policy: "immutable",
      result: { answer: 42 },
      artifacts: [{ role: "output", ordinal: 0, name: "result", artifact }],
    });
    const target = claim(pair.target.database, pair.target.rootScope, 0, "agent", "artifact");
    const before = pair.target.database.readRun().revision;
    const replay = await openReplay(pair);
    const decision = await replay.tryReplayCall({
      operationId: target.operationId,
      semanticKey: hash("artifact"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    });
    expect(decision).toMatchObject({ kind: "hit", artifacts: 1, source: { callKey: sourceCall.callKey } });
    expect(pair.target.database.readRun().revision).toBe(before + 1);
    const [link] = pair.target.database.listOperationArtifacts(target.operationId);
    expect(link).toMatchObject({ role: "output", name: "result", artifact: { digest: artifact.digest } });
    expect(fs.readFileSync(path.join(pair.target.runDir, link!.artifact.bodyPath), "utf8"))
      .toBe(stableJson({ answer: 42 }));
    fs.chmodSync(path.join(pair.source.runDir, artifact.bodyPath), 0o600);
    fs.writeFileSync(path.join(pair.source.runDir, artifact.bodyPath), "source changed later");
    expect(fs.readFileSync(path.join(pair.target.runDir, link!.artifact.bodyPath), "utf8"))
      .toBe(stableJson({ answer: 42 }));
    pair.target.database.validateIntegrity();
  });

  it("restores an exact workspace checkpoint before committing a workspace replay", async () => {
    const pair = createPair();
    const sourceWorkspace = await createWorkspaceEffect(pair.source, "before", "after");
    const targetWorkspace = await createWorkspaceEffect(pair.target, "before");
    const replay = await openReplay(pair);
    const decision = await replay.tryReplayCall({
      operationId: targetWorkspace.effect.operationId,
      semanticKey: hash("workspace-effect"),
      completionAuthority: "host-effect",
      replayPolicy: "workspace",
      workspace: {
        workspaceId: targetWorkspace.workspaceId,
        lineageHash: hash("target-lineage"),
        expectedPreTreeHash: targetWorkspace.initialTreeHash,
      },
      at: time(pair.target.database),
    });
    expect(decision).toMatchObject({
      kind: "hit",
      workspaceRestored: true,
      workspaceCheckpoint: {
        workspaceId: targetWorkspace.workspaceId,
        treeHash: sourceWorkspace.postTreeHash,
        writeScopeHash: targetWorkspace.writeScopeHash,
      },
    });
    expect(fs.readFileSync(path.join(targetWorkspace.root, "value.txt"), "utf8")).toBe("after");
    const call = pair.target.database.readScopeCall(targetWorkspace.effect.operationId)!;
    expect(call.postWorkspaceCheckpointId).toBe((decision as { workspaceCheckpoint: { checkpointId: string } })
      .workspaceCheckpoint.checkpointId);
    pair.target.database.validateIntegrity();
  });

  it("fails closed on corrupt source evidence without committing a partial target call", async () => {
    const pair = createPair();
    const source = claim(pair.source.database, pair.source.rootScope, 0, "agent", "artifact-corrupt");
    const artifact = writeArtifact(pair.source.runDir, pair.source.database, "agent-output", { safe: true });
    completeFresh(pair.source.database, source, {
      semantic: "artifact-corrupt", authority: "finish-work", policy: "immutable",
      result: { safe: true }, artifacts: [{ role: "output", ordinal: 0, artifact }],
    });
    fs.chmodSync(path.join(pair.source.runDir, artifact.bodyPath), 0o600);
    fs.writeFileSync(path.join(pair.source.runDir, artifact.bodyPath), "tampered");
    const target = claim(pair.target.database, pair.target.rootScope, 0, "agent", "artifact-corrupt");
    const replay = await openReplay(pair);
    await expect(replay.tryReplayCall({
      operationId: target.operationId,
      semanticKey: hash("artifact-corrupt"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    })).rejects.toThrow(/digest|wrong size/);
    expect(pair.target.database.readScopeCall(target.operationId)).toBeUndefined();
    expect(pair.target.database.readArtifact(artifact.digest)).toBeUndefined();
  });

  it("recovers idempotently across artifact-materialization and call-commit crash boundaries", async () => {
    for (const point of ["after-artifacts-materialized", "after-call-commit"] as const) {
      const pair = createPair();
      const source = claim(pair.source.database, pair.source.rootScope, 0, "agent", `crash-${point}`);
      const artifact = writeArtifact(pair.source.runDir, pair.source.database, "agent-output", { point });
      const sourceCall = completeFresh(pair.source.database, source, {
        semantic: "crash-boundary", authority: "finish-work", policy: "immutable",
        result: { point }, artifacts: [{ role: "output", ordinal: 0, artifact }],
      });
      const target = claim(pair.target.database, pair.target.rootScope, 0, "agent", `crash-${point}`);
      const crashed = await openReplay(pair, point);
      await expect(crashed.tryReplayCall({
        operationId: target.operationId,
        semanticKey: hash("crash-boundary"),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      })).rejects.toThrow(`crash:${point}`);
      expect(Boolean(pair.target.database.readScopeCall(target.operationId)))
        .toBe(point === "after-call-commit");
      crashed.close();
      closeables.delete(crashed);
      const resumed = await openReplay(pair);
      expect(await resumed.tryReplayCall({
        operationId: target.operationId,
        semanticKey: hash("crash-boundary"),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
        at: time(pair.target.database),
      })).toMatchObject({ kind: "hit", source: { callKey: sourceCall.callKey } });
      pair.target.database.validateIntegrity();
    }
  });

  it("recovers after workspace restoration but before replay evidence commits", async () => {
    const pair = createPair();
    const sourceWorkspace = await createWorkspaceEffect(pair.source, "before", "after-crash");
    const targetWorkspace = await createWorkspaceEffect(pair.target, "before");
    const crashed = await openReplay(pair, "after-workspace-restored");
    const request = {
      operationId: targetWorkspace.effect.operationId,
      semanticKey: hash("workspace-effect"),
      completionAuthority: "host-effect" as const,
      replayPolicy: "workspace" as const,
      workspace: {
        workspaceId: targetWorkspace.workspaceId,
        lineageHash: hash("target-lineage"),
        expectedPreTreeHash: targetWorkspace.initialTreeHash,
      },
      at: time(pair.target.database),
    };
    await expect(crashed.tryReplayCall(request)).rejects.toThrow("crash:after-workspace-restored");
    expect(pair.target.database.readScopeCall(targetWorkspace.effect.operationId)).toBeUndefined();
    expect(fs.readFileSync(path.join(targetWorkspace.root, "value.txt"), "utf8")).toBe("after-crash");
    crashed.close();
    closeables.delete(crashed);
    const resumed = await openReplay(pair);
    expect(await resumed.tryReplayCall(request)).toMatchObject({
      kind: "hit", source: { callKey: sourceWorkspace.call!.callKey }, workspaceRestored: false,
    });
  });

  it("recovers a structural join committed immediately before a crash", async () => {
    const pair = createPair();
    const sourceGroup = createGroup(pair.source.database, "parallel", ["a"]);
    const sourceLane = claim(pair.source.database, sourceGroup.scopes.a.scopeId, 0, "agent", "a");
    const sourceCall = completeFresh(pair.source.database, sourceLane, {
      previous: sourceGroup.scopes.a.seedKey,
      semantic: "a", authority: "finish-work", policy: "immutable", result: { a: true },
    });
    completeScope(pair.source.database, sourceGroup.scopes.a, sourceCall.callKey);
    completeJoin(pair.source.database, sourceGroup.operation, sourceGroup.scopes, {
      order: ["a"], terminals: { a: sourceCall.callKey }, result: { a: { a: true } },
    });

    const targetGroup = createGroup(pair.target.database, "parallel", ["a"]);
    const targetLane = claim(pair.target.database, targetGroup.scopes.a.scopeId, 0, "agent", "a");
    const crashed = await openReplay(pair, "after-join-commit");
    await crashed.tryReplayCall({
      operationId: targetLane.operationId,
      semanticKey: hash("a"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(pair.target.database),
    });
    completeScope(pair.target.database, targetGroup.scopes.a, sourceCall.callKey);
    const input = joinInput(
      targetGroup.operation,
      targetGroup.scopes,
      ["a"],
      { a: sourceCall.callKey },
      { a: { a: true } },
    );
    expect(() => crashed.completeStructuralJoin(input)).toThrow("crash:after-join-commit");
    expect(pair.target.database.readOperation(targetGroup.operation.operationId)?.status).toBe("completed");
    crashed.close();
    closeables.delete(crashed);
    const resumed = await openReplay(pair);
    expect(resumed.completeStructuralJoin(input)).toMatchObject({ replayedSourceJoin: true });
  });

  it("validates the explicit source run and refuses corrupt or unrelated databases", async () => {
    const pair = createPair();
    pair.source.database.close();
    closeables.delete(pair.source.database);
    const raw = new NativeDatabaseSync(pair.source.databasePath);
    raw.prepare("UPDATE scopes SET seed_key = ? WHERE path = 'run'").run(hash("corrupt-root"));
    raw.close();
    await expect(openReplay(pair)).rejects.toThrow(/invalid root scope|root scope/);

    const unrelatedRoot = testRoot();
    const unrelated = {
      source: createRun(path.join(unrelatedRoot, "source"), "flow_v17_source", "user:simple"),
      target: createRun(path.join(unrelatedRoot, "target"), "flow_v17_target", "user:other"),
    };
    await expect(openReplay(unrelated)).rejects.toThrow(WorkflowV17CausalReplayError);

    const changing = createPair();
    const changingSource = claim(changing.source.database, changing.source.rootScope, 0, "agent", "changing");
    completeFresh(changing.source.database, changingSource, {
      semantic: "changing", authority: "finish-work", policy: "immutable", result: { stable: true },
    });
    const changingTarget = claim(changing.target.database, changing.target.rootScope, 0, "agent", "changing");
    const opened = await openReplay(changing);
    changing.source.database.transitionRun(changing.source.database.readRun().revision, {
      status: "paused",
      at: time(changing.source.database),
    });
    await expect(opened.tryReplayCall({
      operationId: changingTarget.operationId,
      semanticKey: hash("changing"),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      at: time(changing.target.database),
    })).rejects.toThrow(/source changed after its evidence snapshot/);
  });
});

function createPair(workflowId = "user:simple", targetSource = SIMPLE_SOURCE) {
  const root = testRoot();
  return {
    source: createRun(path.join(root, "source"), "flow_v17_source", workflowId),
    target: createRun(path.join(root, "target"), "flow_v17_target", workflowId, targetSource),
  };
}

function testRoot(): string {
  const parent = path.resolve("node_modules/.workflow-v17-tests");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(parent, "replay-"));
  roots.push(root);
  return root;
}

function createRun(runDir: string, runId: string, workflowId: string, source = SIMPLE_SOURCE) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const parsed = source === SIMPLE_SOURCE
    ? SIMPLE_PARSED
    : parseWorkflowV17(source, { fileName: "/virtual/simple.flow.ts", apiPath: API });
  const namespace = workflowId.split(":", 1)[0] as "builtin" | "user" | "project";
  const name = workflowId.slice(workflowId.indexOf(":") + 1);
  const policy = defaultWorkflowV17RegistryPolicy(runDir, namespace);
  const ref: WorkflowV17DefinitionRef = {
    formatVersion: 1,
    id: workflowId as WorkflowV17DefinitionRef["id"],
    namespace,
    name,
    description: parsed.metadata.description,
    input: parsed.metadata.input,
    output: parsed.metadata.output,
    exposure: "human",
    policy,
    path: path.join(runDir, `${name}.flow.ts`),
    source,
    sourceHash: parsed.sourceHash,
    definitionHash: workflowV17DefinitionHash(workflowId as WorkflowV17DefinitionRef["id"], parsed),
    parsed,
  };
  const snapshot = createWorkflowV17InvocationSnapshot(ref, { value: "hello" }, {
    authority: "user",
    projectTrusted: namespace === "project",
  });
  const databasePath = path.join(runDir, "run.sqlite");
  const database = track(WorkflowRunDatabaseV17.create(databasePath, {
    runId,
    snapshot,
    projectSnapshotHash: hash("project"),
    routeSnapshotHash: hash("routes"),
    contextIdentityHash: hash("context"),
    safety: safety(),
    createdAt: iso(0),
  }));
  database.transitionRun(1, { status: "running", at: iso(1) });
  return { runDir, databasePath, database, rootScope: database.readRun().rootScopeId };
}

async function openReplay(
  pair: ReturnType<typeof createPair>,
  crashAt?: WorkflowV17CausalReplayFaultPoint,
) {
  return track(await WorkflowV17CausalReplay.open({
    targetRunDir: pair.target.runDir,
    target: pair.target.database,
    sourceRunDir: pair.source.runDir,
    ...(crashAt ? { faultInjector: (point) => {
      if (point === crashAt) throw new Error(`crash:${point}`);
    } } : {}),
  }));
}

function claim(
  database: WorkflowRunDatabaseV17,
  scopeId: string,
  cursor: number,
  kind: WorkflowOperationV17Record["kind"],
  semanticInput: string,
  display: { sourceSite?: string; title?: string } = {},
) {
  return database.claimOperation({
    expectedRevision: database.readRun().revision,
    scopeId,
    cursor,
    kind,
    sourceSite: display.sourceSite ?? `site-${semanticInput.replace(/[^a-z0-9-]/gu, "-")}`,
    ...(display.title ? { title: display.title } : {}),
    semanticInputHash: hash(semanticInput),
    at: time(database),
  }).operation;
}

function completeFresh(
  database: WorkflowRunDatabaseV17,
  operation: WorkflowOperationV17Record,
  input: {
    previous?: string;
    semantic: string;
    authority: "finish-work" | "host-effect";
    policy: "immutable" | "workspace" | "never";
    outcome?: "success" | "failure";
    result: JsonValue;
    postWorkspaceCheckpointId?: string;
    workspaceCheckpoint?: Parameters<WorkflowRunDatabaseV17["completeCall"]>[0]["workspaceCheckpoint"];
    artifacts?: Parameters<WorkflowRunDatabaseV17["completeCall"]>[0]["artifacts"];
  },
) {
  const previousCallKey = input.previous ?? WORKFLOW_V17_ROOT_SCOPE_SEED;
  const outcome = input.outcome ?? "success";
  const semanticKey = hash(input.semantic);
  const callKey = workflowV17FreshCallKey({
    runId: database.readRun().runId,
    previousCallKey,
    operation: workflowV17OperationIdentity(operation),
    semanticKey,
    outcome,
    completionAuthority: input.authority,
    replayPolicy: input.policy,
    result: input.result,
  });
  database.completeCall({
    expectedRevision: database.readRun().revision,
    operationId: operation.operationId,
    previousCallKey,
    semanticKey,
    callKey,
    outcome,
    completionAuthority: input.authority,
    replayPolicy: input.policy,
    ...(outcome === "success" ? { result: input.result } : { failure: input.result as Record<string, JsonValue> }),
    ...(input.postWorkspaceCheckpointId ? { postWorkspaceCheckpointId: input.postWorkspaceCheckpointId } : {}),
    ...(input.workspaceCheckpoint ? { workspaceCheckpoint: input.workspaceCheckpoint } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    at: time(database),
  });
  return database.readScopeCall(operation.operationId)!;
}

function createGroup(
  database: WorkflowRunDatabaseV17,
  kind: "parallel" | "map",
  keys: string[],
) {
  const operation = claim(database, database.readRun().rootScopeId, 0, kind, "group-input");
  const childKind = kind === "parallel" ? "parallel-branch" as const : "map-item" as const;
  const scopes = database.createChildScopes(
    database.readRun().revision,
    operation.operationId,
    keys.map((laneKey) => ({
      kind: childKind,
      laneKey,
      seedKey: workflowV17LaneSeed({
        parentPreviousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
        ownerOperationPath: operation.path,
        ownerKind: kind,
        childKind,
        laneKey,
      }),
    })),
    time(database),
  ).scopes;
  return { operation, scopes: Object.fromEntries(scopes.map((scope) => [scope.laneKey!, scope])) };
}

function completeJoin(
  database: WorkflowRunDatabaseV17,
  operation: WorkflowOperationV17Record,
  scopes: Record<string, WorkflowScopeV17Record>,
  input: { order: string[]; terminals: Record<string, string>; result: JsonValue },
) {
  const structured = joinInput(operation, scopes, input.order, input.terminals, input.result);
  const joinKey = workflowV17StructuralJoinKey({
    previousCallKey: structured.previousCallKey,
    operation: workflowV17OperationIdentity(operation),
    semanticKey: structured.semanticKey,
    policyHash: structured.policyHash,
    outputOrder: structured.outputOrder,
    lanes: structured.lanes,
    result: structured.result!,
  });
  database.completeStructuralJoin({
    ...structured,
    expectedRevision: database.readRun().revision,
    callKey: joinKey,
    joinKey,
  });
  return database.readScopeCall(operation.operationId)!;
}

function joinInput(
  operation: WorkflowOperationV17Record,
  scopes: Record<string, WorkflowScopeV17Record>,
  order: string[],
  terminals: Record<string, string>,
  result: JsonValue,
) {
  return {
    operationId: operation.operationId,
    previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
    semanticKey: hash("group-semantic"),
    kind: operation.kind as "parallel" | "map",
    policyHash: hash("group-policy"),
    outputOrder: order,
    lanes: order.map((laneKey) => ({
      laneKey,
      scopeId: scopes[laneKey]!.scopeId,
      terminalKey: terminals[laneKey]!,
      outcome: "success" as const,
    })),
    result,
    at: iso(900),
  };
}

function completeScope(database: WorkflowRunDatabaseV17, scope: WorkflowScopeV17Record, terminalKey: string) {
  database.completeScope({
    expectedRevision: database.readRun().revision,
    scopeId: scope.scopeId,
    status: "completed",
    terminalKey,
    at: time(database),
  });
}

function writeArtifact(
  runDir: string,
  database: WorkflowRunDatabaseV17,
  kind: string,
  value: JsonValue,
) {
  const body = stableJson(value);
  const digest = sha256(body);
  const bodyPath = `artifacts/${digest.slice(7)}/body`;
  const record = {
    digest,
    runId: database.readRun().runId,
    kind,
    mediaType: "application/json" as const,
    bytes: Buffer.byteLength(body),
    bodyPath,
    metadata: {},
    createdAt: time(database),
  };
  const directory = path.dirname(path.join(runDir, bodyPath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir, bodyPath), body, { mode: 0o400 });
  fs.writeFileSync(path.join(directory, "metadata.json"), stableJson({ formatVersion: 1, ...record }), { mode: 0o400 });
  return record;
}

async function createWorkspaceEffect(
  run: ReturnType<typeof createRun>,
  initial: string,
  post?: string,
) {
  const candidate = claim(run.database, run.rootScope, 0, "candidate", "candidate-input");
  const bodySeed = workflowV17LaneSeed({
    parentPreviousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
    ownerOperationPath: candidate.path,
    ownerKind: "candidate",
    childKind: "candidate-body",
  });
  const body = run.database.createChildScopes(run.database.readRun().revision, candidate.operationId, [{
    kind: "candidate-body", seedKey: bodySeed,
  }], time(run.database)).scopes[0]!;
  const workspaceId = `workspace_${run.database.readRun().runId.replace(/[^a-z0-9]/gu, "")}`;
  const rootPath = `workspaces/candidates/${workspaceId}/project`;
  const root = path.join(run.runDir, rootPath);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "value.txt"), initial);
  const initialTree = (await scanCandidateTree(root)).treeHash;
  const writeScopeHash = hash("workspace-write-scope");
  run.database.createCandidateWorkspace({
    expectedRevision: run.database.readRun().revision,
    workspaceId,
    candidateOperationId: candidate.operationId,
    bodyScopeId: body.scopeId,
    initialTreeHash: initialTree,
    baseLineageHash: hash("workspace-base-lineage"),
    writeScope: { allow: ["value.txt"] },
    writeScopeHash,
    rootPath,
    at: time(run.database),
  });
  const effect = claim(run.database, body.scopeId, 0, "command", "workspace-input");
  if (!post) return { candidate, body, effect, workspaceId, root, initialTreeHash: initialTree, writeScopeHash };

  fs.writeFileSync(path.join(root, "value.txt"), post);
  const postTreeHash = (await scanCandidateTree(root)).treeHash;
  const checkpointId = `checkpoint_${run.database.readRun().runId.replace(/[^a-z0-9]/gu, "")}`;
  const storagePath = `workspaces/checkpoints/${checkpointId}`;
  const checkpointRoot = path.join(run.runDir, storagePath);
  const manifest = await cloneCandidateTree(root, checkpointRoot, { durable: true });
  if (manifest.treeHash !== postTreeHash) throw new Error("source checkpoint clone changed");
  const checkpoint = {
    checkpointId,
    runId: run.database.readRun().runId,
    operationId: effect.operationId,
    workspaceId,
    treeHash: postTreeHash,
    lineageHash: hash("source-lineage"),
    writeScopeHash,
    storagePath,
    createdAt: time(run.database),
  };
  const call = completeFresh(run.database, effect, {
    previous: bodySeed,
    semantic: "workspace-effect",
    authority: "host-effect",
    policy: "workspace",
    result: { changed: true },
    postWorkspaceCheckpointId: checkpointId,
    workspaceCheckpoint: checkpoint,
  });
  return {
    candidate, body, effect, workspaceId, root, initialTreeHash: initialTree,
    writeScopeHash, postTreeHash, call, checkpoint,
  };
}

function hash(value: string) { return stableHash({ value }); }
function iso(offset: number) { return new Date(BASE_TIME + offset * 1_000).toISOString(); }
function time(database: WorkflowRunDatabaseV17) { return iso(database.readRun().revision + 1); }

function safety(): SafetyConfiguration {
  return {
    concurrency: 4,
    maximumAgentLaunches: 64,
    memoryBytes: 1024 * 1024 * 1024,
    tasks: 128,
    cpuQuotaPercent: 400,
    cpuWeight: 100,
    outputBytes: 64 * 1024 * 1024,
    commandTimeoutMs: 60_000,
  };
}

function track<T extends { close(): void }>(value: T): T {
  closeables.add(value);
  return value;
}
