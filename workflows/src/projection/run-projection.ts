import type { WorkflowDescriptor } from "../definition/workflow-types.js";
import {
  assertWorkflowInvocationSnapshot,
  type WorkflowInvocationSnapshot,
  type WorkflowMeasurementResourceBinding,
} from "../persistence/workflow-invocation.js";
import {
  workflowResourceId,
  type WorkflowRunDatabaseReader,
} from "../persistence/run-database.js";
import type {
  WorkflowArtifactRecord,
  WorkflowOperationRecord,
  WorkflowScopeRecord,
} from "../persistence/run-database-types.js";
import type { WorkflowDefinitionRef } from "../registry/structured-workflows.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  WORKFLOW_PROJECTION_LIMITS as LIMITS,
  type WorkflowArtifactProjection,
  type WorkflowCandidateProjection,
  type WorkflowDefinitionReviewProjection,
  type WorkflowExperimentProjection,
  type WorkflowHumanInteractionProjection,
  type WorkflowMeasurementProjection,
  type WorkflowMetricSetProjection,
  type WorkflowOperationProjection,
  type WorkflowResourceProjection,
  type WorkflowRunProjection,
  type WorkflowStructureProjection,
} from "./types.js";

/** One coherent, detached schema-4 projection. */
export function readWorkflowRunProjection(
  reader: WorkflowRunDatabaseReader,
  snapshot: WorkflowInvocationSnapshot,
  options: { shortRunId?: string } = {},
): WorkflowRunProjection {
  assertWorkflowInvocationSnapshot(snapshot);
  return reader.readSnapshot(database => {
    const run = database.readRun();
    assertSnapshotRunBinding(run, snapshot);
    const operations = database.listOperations({ limit: LIMITS.overviewOperations });
    const scopes = new Map(database.listScopes().map(scope => [scope.scopeId, scope]));
    const descriptorBySite = new Map(snapshot.descriptors.map(descriptor => [descriptor.identity.sourceSite, descriptor]));
    const projectedOperations = operations.map(operation => projectOperation(
      database, operation, scopes, descriptorBySite,
    ));
    const candidateRecords = database.listCandidates().slice(-LIMITS.overviewCandidates);
    const candidates = candidateRecords.map(candidate => projectCandidate(database, candidate));
    const metricSets = database.listMetricSets().map(metricSet => ({
      metricSetId: metricSet.metricSetId,
      sourceSite: metricSet.sourceSite,
      occurrence: metricSet.occurrence,
      policy: structuredClone(metricSet.policy),
      sampling: structuredClone(metricSet.sampling),
      metrics: metricSet.states.map(state => ({
        metricId: state.metricId,
        title: state.definition.title,
        role: state.role,
        direction: state.definition.direction,
        ...(state.definition.unit ? { unit: state.definition.unit } : {}),
        baseline: state.baseline,
        current: state.current,
        best: state.best,
        relativeGain: state.relativeGain,
        observationCount: state.observationCount,
      })),
    })) satisfies WorkflowMetricSetProjection[];
    const measurements = database.listMeasurements().slice(-LIMITS.overviewMeasurements)
      .map(measurement => projectMeasurement(database, measurement));
    const experiments = database.listExperiments().slice(-LIMITS.overviewExperiments)
      .map(experiment => projectExperiment(database, experiment));
    const resources = database.listInvocationResources().map(record => projectResource(record.resource, record.resourceId));
    const structures = projectedOperations
      .filter(operation => operation.kind === "parallel" || operation.kind === "map" || operation.kind === "candidate")
      .map(operation => projectStructure(database, operation, scopes, projectedOperations));
    const humanInteractions = projectHumanInteractions(database, projectedOperations, candidates);
    const attention = projectAttention(run.reason, projectedOperations, candidates, humanInteractions);
    const projection: WorkflowRunProjection = {
      formatVersion: 1,
      runtimeVersion: 17,
      runId: run.runId,
      shortRunId: options.shortRunId ?? shortRunId(run.runId),
      workflowId: run.workflow.id,
      workflowName: run.workflow.name,
      ...(snapshot.title ? { title: bounded(snapshot.title, 192) } : {}),
      description: bounded(snapshot.description, 2_000),
      revision: run.revision,
      status: run.status,
      launch: structuredClone(run.launch),
      capabilities: [...run.capabilities],
      safety: {
        concurrency: run.safety.concurrency,
        maximumAgentLaunches: run.safety.maximumAgentLaunches,
      },
      operationCounts: database.readOperationCounts(),
      operations: projectedOperations,
      operationOmittedCount: Math.max(0, database.countOperations() - projectedOperations.length),
      structures,
      candidates,
      metricSets,
      measurements,
      experiments,
      resources,
      humanInteractions,
      artifacts: database.listArtifacts({ limit: LIMITS.overviewArtifacts }).map(projectArtifact),
      attention,
      latestEventSequence: database.latestEventSequence(),
      createdAt: run.createdAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      updatedAt: run.updatedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    };
    boundProjection(projection);
    return projection;
  });
}

export function projectWorkflowDefinitionReview(
  ref: WorkflowDefinitionRef,
  snapshot?: WorkflowInvocationSnapshot,
): WorkflowDefinitionReviewProjection {
  if (snapshot) {
    assertWorkflowInvocationSnapshot(snapshot);
    if (snapshot.workflowId !== ref.id || snapshot.definitionHash !== ref.definitionHash
      || snapshot.sourceHash !== ref.sourceHash) {
      throw new Error("Workflow v17 launch review does not bind the installed definition");
    }
  }
  const review = ref.parsed.review;
  return {
    formatVersion: 1,
    workflowId: ref.id,
    name: ref.name,
    ...(ref.title ? { title: bounded(ref.title, 192) } : {}),
    description: bounded(ref.description, 2_000),
    exposure: ref.exposure,
    policyHash: ref.policy.hash,
    definitionHash: ref.definitionHash,
    sourceHash: ref.sourceHash,
    inputSchema: structuredClone(ref.input),
    outputSchema: structuredClone(ref.output),
    ...(ref.concurrency !== undefined ? { concurrency: ref.concurrency } : {}),
    authority: {
      capabilities: [...review.capabilities],
      descriptors: ref.parsed.descriptors.map(descriptor => ({
        binding: descriptor.binding,
        kind: descriptor.kind,
        profile: descriptor.profile,
        ...(descriptor.kind === "agent-task" ? {
          workspace: descriptor.workspace,
          network: descriptor.network,
        } : { effect: descriptor.effect }),
        sourceSite: descriptor.identity.sourceSite,
      })),
      verificationProfiles: [...review.verificationProfiles],
      measurementProfiles: [...review.measurementProfiles],
      dynamicResources: structuredClone(review.dynamicResources),
      candidateWrites: structuredClone(review.candidateWrites),
      humanInteractionSites: [...review.humanInteractionSites],
      applySites: [...review.applySites],
      suspiciousUnboundedLoops: structuredClone(review.suspiciousUnboundedLoops),
    },
    ...(snapshot ? {
      launchBinding: {
        snapshotHash: snapshot.snapshotHash,
        authority: snapshot.launch.authority,
        projectTrusted: snapshot.launch.projectTrusted,
        resources: snapshot.resources.map(resource => projectResource(resource)),
      },
    } : {}),
  };
}

function projectOperation(
  database: WorkflowRunDatabaseReader,
  operation: WorkflowOperationRecord,
  scopes: ReadonlyMap<string, WorkflowScopeRecord>,
  descriptors: ReadonlyMap<string, WorkflowDescriptor>,
): WorkflowOperationProjection {
  const scope = scopes.get(operation.scopeId);
  if (!scope) throw new Error(`Workflow v17 projection is missing scope ${operation.scopeId}`);
  const descriptor = operation.descriptorSourceSite
    ? descriptors.get(operation.descriptorSourceSite)
    : undefined;
  const call = database.readScopeCall(operation.operationId);
  const links = database.listOperationArtifacts(operation.operationId)
    .filter(link => link.role === "output" || link.role === "evidence")
    .slice(0, 16);
  const settlement = database.readEffectSettlement(operation.operationId);
  const checkpoint = settlement?.postWorkspaceCheckpointId
    ? database.readWorkspaceCheckpoint(settlement.postWorkspaceCheckpointId)
    : undefined;
  return {
    operationId: operation.operationId,
    ...(scope.ownerOperationId ? { parentOperationId: scope.ownerOperationId } : {}),
    scopeId: scope.scopeId,
    scopePath: bounded(scope.path, 1_024),
    scopeKind: scope.kind,
    ...(scope.laneKey ? { laneKey: bounded(scope.laneKey, 128) } : {}),
    depth: scopeDepth(scope, scopes),
    cursor: operation.cursor,
    ordinal: operation.ordinal,
    path: bounded(operation.path, 1_024),
    kind: operation.kind,
    status: operation.status,
    sourceSite: operation.sourceSite,
    ...(operation.descriptorSourceSite ? { descriptorSourceSite: operation.descriptorSourceSite } : {}),
    ...(descriptor ? { descriptor: {
      binding: descriptor.binding,
      kind: descriptor.kind,
      profile: descriptor.profile,
      ...(descriptor.kind === "agent-task" ? {
        workspace: descriptor.workspace,
        network: descriptor.network,
      } : { effect: descriptor.effect }),
    } } : {}),
    ...(operation.title ? { title: bounded(operation.title, 512) } : {}),
    ...(call?.replay ? { replay: {
      sourceRunId: call.replay.sourceRunId,
      sourceOperationId: call.replay.sourceOperationId,
      sourceScopePath: call.replay.sourceScopePath,
      sourceCursor: call.replay.sourceCursor,
      workspaceRestored: call.postWorkspaceCheckpointId !== undefined,
    } } : {}),
    outputArtifacts: links.map(link => projectArtifact(link.artifact)),
    ...(checkpoint ? { checkpoint: {
      checkpointId: checkpoint.checkpointId,
      workspaceId: checkpoint.workspaceId,
      treeHash: checkpoint.treeHash,
    } } : {}),
    ...(operation.failure ? { failure: structuredClone(operation.failure) } : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.endedAt ? { endedAt: operation.endedAt } : {}),
  };
}

function projectStructure(
  database: WorkflowRunDatabaseReader,
  operation: WorkflowOperationProjection,
  scopes: ReadonlyMap<string, WorkflowScopeRecord>,
  operations: readonly WorkflowOperationProjection[],
): WorkflowStructureProjection {
  const children = database.listChildScopes(operation.operationId);
  const join = database.readStructuralJoin(operation.operationId);
  const joinByScope = new Map(join?.lanes.map(lane => [lane.scopeId, lane.outcome]) ?? []);
  return {
    operationId: operation.operationId,
    kind: operation.kind as WorkflowStructureProjection["kind"],
    path: operation.path,
    ...(operation.title ? { title: operation.title } : {}),
    status: operation.status,
    outputOrder: join ? [...join.outputOrder] : children.map(child => child.laneKey ?? "candidate"),
    lanes: children.map(child => ({
      key: child.laneKey ?? "candidate",
      scopeId: child.scopeId,
      scopePath: child.path,
      scopeKind: child.kind as Exclude<WorkflowScopeRecord["kind"], "root">,
      outcome: joinByScope.get(child.scopeId)
        ?? (child.status === "active" ? "active" : child.status === "completed" ? "success" : child.status === "failed" ? "failure" : "cancelled"),
      operationIds: operations.filter(entry => entry.scopeId === child.scopeId).map(entry => entry.operationId),
    })),
  };
}

function projectCandidate(
  database: WorkflowRunDatabaseReader,
  candidate: ReturnType<WorkflowRunDatabaseReader["listCandidates"]>[number],
): WorkflowCandidateProjection {
  const manifest = requireArtifact(database, candidate.manifestArtifactDigest);
  const diff = requireArtifact(database, candidate.diffArtifactDigest);
  const verifications = database.listCandidateVerifications(candidate.candidateId).map(verification => ({
    verificationId: verification.verificationId,
    operationId: verification.operationId,
    status: verification.status,
    artifact: projectArtifact(requireArtifact(database, verification.artifactDigest)),
  }));
  const measurement = database.readCandidateMeasurement(candidate.candidateId);
  const apply = database.readCandidateApply(candidate.candidateId);
  return {
    candidateId: candidate.candidateId,
    ...(candidate.parentCandidateId ? { parentCandidateId: candidate.parentCandidateId } : {}),
    operationId: candidate.operationId,
    state: candidate.state,
    treeHash: candidate.treeHash,
    lineageHash: candidate.lineageHash,
    writeScopeHash: candidate.writeScopeHash,
    changedPathCount: candidate.changedPaths.length,
    changedPathPreview: candidate.changedPaths.slice(0, LIMITS.changedPathPreview),
    output: boundedJson(candidate.output),
    manifest: projectArtifact(manifest),
    diff: projectArtifact(diff),
    verification: verifications,
    ...(measurement ? { measurement: {
      measurementId: measurement.measurementId,
      operationId: measurement.operationId,
      status: measurement.status,
    } } : {}),
    ...(candidate.disposition ? { disposition: {
      disposition: candidate.disposition.disposition,
      ...(candidate.disposition.operationId ? { operationId: candidate.disposition.operationId } : {}),
      ...(candidate.disposition.verificationId ? { verificationId: candidate.disposition.verificationId } : {}),
      ...(candidate.disposition.measurementId ? { measurementId: candidate.disposition.measurementId } : {}),
      ...(candidate.disposition.reason ? { reason: structuredClone(candidate.disposition.reason) } : {}),
      disposedAt: candidate.disposition.disposedAt,
    } } : {}),
    ...(apply ? { apply: {
      operationId: apply.operationId,
      approvalId: apply.approvalId,
      receiptId: apply.receiptId,
      appliedAt: apply.appliedAt,
    } } : {}),
    frozenAt: candidate.frozenAt,
  };
}

function projectMeasurement(
  database: WorkflowRunDatabaseReader,
  measurement: ReturnType<WorkflowRunDatabaseReader["listMeasurements"]>[number],
): WorkflowMeasurementProjection {
  return {
    measurementId: measurement.measurementId,
    operationId: measurement.operationId,
    metricSetId: measurement.metricSetId,
    profileId: measurement.profile.id,
    profileHash: measurement.profileHash,
    ...(measurement.candidateId ? { candidateId: measurement.candidateId } : {}),
    workspaceTreeHash: measurement.workspaceTreeHash,
    observations: structuredClone(measurement.observations),
    sampleCount: measurement.samples.length,
    artifact: projectArtifact(requireArtifact(database, measurement.artifactDigest)),
    ...(measurement.diagnosticsArtifactDigest ? {
      diagnostics: projectArtifact(requireArtifact(database, measurement.diagnosticsArtifactDigest)),
    } : {}),
    createdAt: measurement.createdAt,
  };
}

function projectExperiment(
  database: WorkflowRunDatabaseReader,
  experiment: ReturnType<WorkflowRunDatabaseReader["listExperiments"]>[number],
): WorkflowExperimentProjection {
  return {
    experimentId: experiment.experimentId,
    operationId: experiment.operationId,
    candidateId: experiment.candidateId,
    measurementId: experiment.measurementId,
    disposition: experiment.disposition,
    learned: bounded(experiment.learned, 4_000),
    artifact: projectArtifact(requireArtifact(database, experiment.artifactDigest)),
    createdAt: experiment.createdAt,
  };
}

function projectHumanInteractions(
  database: WorkflowRunDatabaseReader,
  operations: readonly WorkflowOperationProjection[],
  candidates: readonly WorkflowCandidateProjection[],
): WorkflowHumanInteractionProjection[] {
  const asks = operations.filter(operation => operation.kind === "ask").map(operation => {
    const result = database.readOperation(operation.operationId)?.result;
    const approvalId = plainRecord(result) && typeof result.approvalId === "string"
      ? result.approvalId
      : undefined;
    return {
      operationId: operation.operationId,
      kind: "ask" as const,
      status: operation.status,
      ...(operation.title ? { title: operation.title } : {}),
      ...(approvalId ? { approvalId: bounded(approvalId, 512) } : {}),
    };
  });
  const applies = candidates.flatMap(candidate => candidate.apply ? [{
    operationId: candidate.apply.operationId,
    kind: "apply" as const,
    status: "completed" as const,
    approvalId: candidate.apply.approvalId,
    receiptId: candidate.apply.receiptId,
  }] : []);
  return [...asks, ...applies];
}

function projectResource(
  resource: WorkflowMeasurementResourceBinding,
  resourceId = workflowResourceId(resource.inputPath, resource.bindingHash),
): WorkflowResourceProjection {
  return {
    resourceId,
    kind: "measurement-profile",
    inputPath: resource.inputPath,
    selector: resource.identity.selector,
    snapshotHash: resource.identity.snapshotHash,
    bindingHash: resource.bindingHash,
    outputs: resource.uses.flatMap(use => use.outputs.map(output => ({
      operationSite: use.operationSite,
      output: output.output,
      role: output.role,
    }))),
  };
}

function projectAttention(
  reason: JsonObject | undefined,
  operations: readonly WorkflowOperationProjection[],
  candidates: readonly WorkflowCandidateProjection[],
  human: readonly WorkflowHumanInteractionProjection[],
): WorkflowRunProjection["attention"] {
  const result: WorkflowRunProjection["attention"] = [];
  if (reason) result.push({
    code: typeof reason.code === "string" ? bounded(reason.code, 256) : "run-attention",
    summary: typeof reason.summary === "string" ? bounded(reason.summary) : "Workflow requires attention",
    ...(typeof reason.operationId === "string" ? { operationId: reason.operationId } : {}),
  });
  for (const operation of operations.filter(value => value.status === "failed")) {
    result.push({
      code: "operation-failed",
      summary: `${operation.title ?? operation.kind} failed`,
      operationId: operation.operationId,
    });
  }
  for (const candidate of candidates.filter(value => value.state === "pending")) {
    result.push({ code: "candidate-pending", summary: "Changed candidate has no disposition", operationId: candidate.operationId });
  }
  for (const interaction of human.filter(value => value.status === "waiting")) {
    result.push({ code: `${interaction.kind}-waiting`, summary: `${interaction.kind} requires a human response`, operationId: interaction.operationId });
  }
  return result.slice(0, 32);
}

function projectArtifact(record: WorkflowArtifactRecord): WorkflowArtifactProjection {
  return {
    digest: record.digest,
    kind: bounded(record.kind, 256),
    mediaType: record.mediaType,
    bytes: record.bytes,
    createdAt: record.createdAt,
  };
}

function requireArtifact(database: WorkflowRunDatabaseReader, digest: string): WorkflowArtifactRecord {
  const record = database.readArtifact(digest);
  if (!record) throw new Error(`Workflow v17 projection is missing artifact ${digest}`);
  return record;
}

function scopeDepth(
  scope: WorkflowScopeRecord,
  scopes: ReadonlyMap<string, WorkflowScopeRecord>,
): number {
  let depth = 0;
  let current = scope;
  const seen = new Set([scope.scopeId]);
  while (current.parentScopeId) {
    const parent = scopes.get(current.parentScopeId);
    if (!parent || seen.has(parent.scopeId) || depth >= 32) break;
    seen.add(parent.scopeId);
    depth++;
    current = parent;
  }
  return depth;
}

function assertSnapshotRunBinding(
  run: ReturnType<WorkflowRunDatabaseReader["readRun"]>,
  snapshot: WorkflowInvocationSnapshot,
): void {
  if (run.workflow.id !== snapshot.workflowId
    || run.workflow.sourceHash !== snapshot.sourceHash
    || run.workflow.definitionHash !== snapshot.definitionHash
    || run.workflow.snapshotHash !== snapshot.snapshotHash
    || run.workflow.runtimeApiHash !== snapshot.runtimeApiHash
    || run.resourcesHash !== snapshot.resourcesHash
    || run.launch.authority !== snapshot.launch.authority
    || run.launch.exposure !== snapshot.exposure
    || run.launch.policyHash !== snapshot.launch.policyHash
    || run.launch.projectTrusted !== snapshot.launch.projectTrusted) {
    throw new Error("Workflow v17 projection snapshot differs from run identity");
  }
}

function boundProjection(projection: WorkflowRunProjection): void {
  while (bytes(projection) > LIMITS.projectionBytes && projection.operations.length > 1) {
    projection.operations.pop();
    projection.operationOmittedCount++;
  }
  while (bytes(projection) > LIMITS.projectionBytes && projection.artifacts.length > 0) projection.artifacts.pop();
  while (bytes(projection) > LIMITS.projectionBytes && projection.measurements.length > 0) projection.measurements.shift();
  while (bytes(projection) > LIMITS.projectionBytes && projection.experiments.length > 0) projection.experiments.shift();
  while (bytes(projection) > LIMITS.projectionBytes && projection.candidates.length > 1) projection.candidates.shift();
  while (bytes(projection) > LIMITS.projectionBytes && projection.structures.length > 0) projection.structures.pop();
  while (bytes(projection) > LIMITS.projectionBytes && projection.metricSets.length > 0) projection.metricSets.pop();
  while (bytes(projection) > LIMITS.projectionBytes && projection.resources.length > 0) projection.resources.pop();
  if (bytes(projection) > LIMITS.projectionBytes) {
    throw new Error(`Workflow v17 projection exceeds ${LIMITS.projectionBytes} bytes after bounded reduction`);
  }
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function boundedJson(value: JsonValue, maximumBytes = 16 * 1024): JsonValue {
  const copy = structuredClone(value);
  const serialized = JSON.stringify(copy);
  const size = Buffer.byteLength(serialized, "utf8");
  return size <= maximumBytes ? copy : { detailOmitted: true, bytes: size };
}
function shortRunId(runId: string): string { return runId.replace(/^flow_v17_/u, "").slice(0, 12); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function boundedWorkflowProjectionText(value: unknown, maximum: number = LIMITS.textScalars): string {
  return bounded(String(value ?? ""), maximum);
}

function bounded(value: string, maximum: number = LIMITS.textScalars): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�");
  const scalars = Array.from(clean);
  return scalars.length <= maximum ? clean : `${scalars.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}
