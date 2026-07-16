import type { DatabaseSync } from "./sqlite.js";
import type { ExperimentRecord } from "../experiments/records.js";
import {
  normalizeExperimentCandidateMetadata,
  normalizeExperimentLearned,
} from "../experiments/records.js";
import {
  applyMetricCohortDeltaToSnapshot,
  applyMetricDispositionToSnapshot,
  normalizeMetricCohortDelta,
  normalizeMetricDefinition,
  type PersistedMetricObservation,
  type PersistedMetricState,
} from "../measurements/metrics.js";
import {
  measurementBindingHash,
  type MeasurementDispositionRecord,
  type MeasurementRecord,
  type MeasurementSampleRecord,
} from "../measurements/records.js";
import type { ArtifactRef } from "../runtime/durable-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertWorkspace,
  decodeCanonicalJson,
  encodeCanonicalJson,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { RunDatabaseCorruptionError } from "./run-database-codec.js";
import { RunDatabaseStateError } from "./run-database-errors.js";
import { requiredArtifactRef, workspaceValues } from "./run-database-records.js";

export function insertMeasurement(
  database: DatabaseSync,
  record: MeasurementRecord,
  runId: string,
  operationId: string,
  attemptId: string | undefined,
): void {
  assertMeasurementRecord(record);
  if (record.runId !== runId || record.operationId !== operationId || record.attemptId !== attemptId) {
    throw new TypeError("Measurement completion binding is invalid");
  }
  const operation = database.prepare("SELECT kind FROM operations WHERE operation_id = ? AND run_id = ?")
    .get(operationId, runId) as SqlRow | undefined;
  if (!operation || requiredString(operation, "kind") !== "measure") {
    throw new RunDatabaseStateError("Measurement completion operation is invalid");
  }
  if (attemptId) {
    const attempt = database.prepare("SELECT effect FROM attempts WHERE attempt_id = ? AND operation_id = ?")
      .get(attemptId, operationId) as SqlRow | undefined;
    if (!attempt || requiredString(attempt, "effect") !== "measurement") {
      throw new RunDatabaseStateError("Measurement attempt is invalid");
    }
  }
  for (const artifact of measurementArtifacts(record)) requiredArtifactRef(database, artifact);
  if (record.candidateId) assertCandidateBinding(database, record);

  const current = readMetricStates(database, runId);
  const next = applyMetricCohortDeltaToSnapshot(current, record.delta);
  const nextByMetric = new Map(next.map((metric) => [metric.metricId, metric]));

  database.prepare(`
    INSERT INTO measurements(
      measurement_id, run_id, operation_id, attempt_id, profile_id, profile_hash,
      command_json, command_hash, workspace_kind, workspace_id, workspace_tree_hash,
      workspace_lineage_hash, workspace_write_scope_hash, candidate_id,
      sampling_json, sampling_hash, cpu_affinity_physical_cores,
      environment_json, environment_hash, binding_hash,
      cohort_artifact_digest, diagnostics_artifact_digest, diagnostics_json, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.measurementId, runId, operationId, attemptId ?? null,
    record.profileId, record.profileHash, encodeCanonicalJson(record.command as unknown as JsonValue), record.commandHash,
    ...workspaceValues(record.workspace), record.candidateId ?? null,
    encodeCanonicalJson(record.sampling as unknown as JsonValue), record.samplingHash,
    record.cpuAffinity?.physicalCores ?? null,
    encodeCanonicalJson(record.environment), record.environmentHash, record.bindingHash,
    record.cohortArtifact.digest, record.diagnosticsArtifact?.digest ?? null,
    encodeCanonicalJson(record.diagnostics as unknown as JsonValue), record.startedAt, record.endedAt,
  );

  for (const sample of record.samples) insertSample(database, record.measurementId, sample);
  for (const metric of next) upsertMetric(database, runId, metric);
  for (const [ordinal, observation] of record.delta.observations.entries()) {
    const state = nextByMetric.get(observation.metricId)!;
    const persisted = state.recentObservations.find((entry) => entry.observationId === observation.observationId);
    if (!persisted) throw new RunDatabaseStateError(`Metric ${observation.metricId} did not retain its new observation`);
    database.prepare(`
      INSERT INTO measurement_observations(
        measurement_id, run_id, ordinal, sequence, observation_id, metric_id, output_id,
        value, samples_json, initial_status, status, best_reference, improvement_passed, guardrail_passed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.measurementId, runId, ordinal, persisted.sequence, observation.observationId,
      observation.metricId, observation.outputId, observation.value,
      encodeCanonicalJson(observation.samples as unknown as JsonValue), observation.status, persisted.status,
      persisted.bestReference,
      booleanValue(persisted.improvementPassed), booleanValue(persisted.guardrailPassed),
    );
  }
}

export function readMeasurement(database: DatabaseSync, measurementId: string): MeasurementRecord | undefined {
  assertIdentifier(measurementId, "measurement id");
  const row = database.prepare("SELECT * FROM measurements WHERE measurement_id = ?").get(measurementId) as SqlRow | undefined;
  return row ? measurementFromRow(database, row) : undefined;
}

export function readMeasurementByOperation(database: DatabaseSync, operationId: string): MeasurementRecord | undefined {
  assertIdentifier(operationId, "measurement operation id");
  const row = database.prepare("SELECT * FROM measurements WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
  return row ? measurementFromRow(database, row) : undefined;
}

export function listMeasurements(database: DatabaseSync, limit: number): MeasurementRecord[] {
  const bounded = pageLimit(limit);
  const rows = database.prepare("SELECT measurement_id FROM measurements ORDER BY ended_at, measurement_id LIMIT ?")
    .all(bounded) as SqlRow[];
  return rows.map((row) => readMeasurement(database, requiredString(row, "measurement_id"))!);
}

export function readMeasurementDisposition(
  database: DatabaseSync,
  measurementId: string,
): MeasurementDispositionRecord | undefined {
  assertIdentifier(measurementId, "measurement disposition id");
  const row = database.prepare("SELECT * FROM measurement_dispositions WHERE measurement_id = ?")
    .get(measurementId) as SqlRow | undefined;
  return row ? measurementDispositionFromRow(row) : undefined;
}

export function readMeasurementDispositionByOperation(
  database: DatabaseSync,
  operationId: string,
): MeasurementDispositionRecord | undefined {
  assertIdentifier(operationId, "measurement disposition operation id");
  const row = database.prepare("SELECT * FROM measurement_dispositions WHERE operation_id = ?")
    .get(operationId) as SqlRow | undefined;
  return row ? measurementDispositionFromRow(row) : undefined;
}

/** Finalize candidate observations in the same transaction as accept/reject completion. */
export function finalizeMeasurementDisposition(
  database: DatabaseSync,
  input: {
    runId: string;
    operationId: string;
    operationPath: string;
    operationKind: string;
    value: JsonValue | undefined;
    disposedAt: string;
  },
): void {
  if (input.operationKind !== "accept" && input.operationKind !== "reject") return;
  const value = optionalRecord(input.value);
  if (!value || !Object.prototype.hasOwnProperty.call(value, "measurement")) return;
  const disposition = input.operationKind === "accept" ? "accepted" as const : "rejected" as const;
  const measurementBinding = requiredRecord(value.measurement, "candidate measurement disposition");
  const measurementId = requiredStringValue(measurementBinding.measurementId, "measurement disposition id");
  assertIdentifier(measurementId, "measurement disposition id");
  assertIsoDate(input.disposedAt, "measurement disposition time");
  assertDispositionResult(value, disposition, input.operationPath);

  const measurement = readMeasurement(database, measurementId);
  if (!measurement || measurement.runId !== input.runId || !measurement.candidateId) {
    throw new RunDatabaseStateError("Measurement is not bound to its candidate");
  }
  const expectedMeasurement = {
    measurementId: measurement.measurementId,
    profileHash: measurement.profileHash,
    environmentHash: measurement.environmentHash,
    bindingHash: measurement.bindingHash,
  };
  if (stableHash(measurementBinding) !== stableHash(expectedMeasurement)) {
    throw new RunDatabaseStateError("Candidate disposition changed its exact measurement binding");
  }
  assertDispositionCandidate(database, measurement, value.candidate);

  const operation = database.prepare("SELECT ordinal FROM operations WHERE operation_id = ? AND run_id = ?")
    .get(input.operationId, input.runId) as SqlRow | undefined;
  const measuredOperation = database.prepare("SELECT ordinal FROM operations WHERE operation_id = ? AND run_id = ?")
    .get(measurement.operationId, input.runId) as SqlRow | undefined;
  if (!operation || !measuredOperation || requiredNumber(measuredOperation, "ordinal") >= requiredNumber(operation, "ordinal")) {
    throw new RunDatabaseStateError("Measurement disposition must follow its measurement operation");
  }
  const existing = readMeasurementDisposition(database, measurementId);
  if (existing) {
    throw new RunDatabaseStateError(`Measurement ${measurementId} was already ${existing.disposition}`);
  }
  const observations = database.prepare(
    "SELECT initial_status, status FROM measurement_observations WHERE measurement_id = ? ORDER BY ordinal",
  ).all(measurementId) as SqlRow[];
  if (
    observations.length !== measurement.delta.observations.length
    || observations.some((row) => requiredString(row, "initial_status") !== "pending" || requiredString(row, "status") !== "pending")
  ) throw new RunDatabaseStateError("Measurement observations are not pending disposition");

  const next = applyMetricDispositionToSnapshot(readMetricStates(database, input.runId), measurement.delta, disposition);
  const changed = database.prepare(
    "UPDATE measurement_observations SET status = ? WHERE measurement_id = ? AND status = 'pending'",
  ).run(disposition, measurementId).changes;
  if (Number(changed) !== observations.length) throw new RunDatabaseStateError("Measurement disposition lost an observation race");
  for (const metric of next) upsertMetric(database, input.runId, metric);
  database.prepare(`
    INSERT INTO measurement_dispositions(
      measurement_id, run_id, operation_id, candidate_id, disposition, disposed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    measurementId,
    input.runId,
    input.operationId,
    measurement.candidateId,
    disposition,
    input.disposedAt,
  );
}

export function readMetric(database: DatabaseSync, runId: string, metricId: string): PersistedMetricState | undefined {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(metricId)) throw new TypeError("Invalid metric id");
  return readMetricStates(database, runId).find((metric) => metric.metricId === metricId);
}

export function listMetrics(database: DatabaseSync, runId: string): PersistedMetricState[] {
  return readMetricStates(database, runId);
}

export function listMetricsPage(
  database: DatabaseSync,
  runId: string,
  afterMetricId: string,
  limit: number,
): PersistedMetricState[] {
  return readMetricStates(database, runId, afterMetricId, pageLimit(limit));
}

export function insertExperiment(database: DatabaseSync, record: ExperimentRecord, runId: string, operationId: string): void {
  assertExperimentRecord(record);
  if (record.runId !== runId || record.operationId !== operationId) throw new TypeError("Experiment completion binding is invalid");
  const operation = database.prepare("SELECT kind, ordinal FROM operations WHERE operation_id = ? AND run_id = ?")
    .get(operationId, runId) as SqlRow | undefined;
  if (!operation || requiredString(operation, "kind") !== "record-experiment") {
    throw new RunDatabaseStateError("Experiment completion operation is invalid");
  }
  const candidate = database.prepare("SELECT tree_hash, lineage_hash, write_scope_hash FROM candidates WHERE candidate_id = ? AND run_id = ?")
    .get(record.candidateId, runId) as SqlRow | undefined;
  const measurement = database.prepare("SELECT candidate_id, binding_hash FROM measurements WHERE measurement_id = ? AND run_id = ?")
    .get(record.measurementId, runId) as SqlRow | undefined;
  const disposition = database.prepare(`
    SELECT d.candidate_id, d.disposition, o.kind, o.ordinal, o.status
    FROM measurement_dispositions d
    JOIN operations o ON o.operation_id = d.operation_id AND o.run_id = d.run_id
    WHERE d.measurement_id = ? AND d.operation_id = ? AND d.run_id = ?
  `).get(record.measurementId, record.dispositionOperationId, runId) as SqlRow | undefined;
  if (!candidate || !measurement || optionalString(measurement, "candidate_id") !== record.candidateId) {
    throw new RunDatabaseStateError("Experiment candidate and measurement are not exactly linked");
  }
  if (
    !disposition || requiredString(disposition, "status") !== "completed" ||
    requiredNumber(disposition, "ordinal") >= requiredNumber(operation, "ordinal") ||
    requiredString(disposition, "candidate_id") !== record.candidateId ||
    requiredString(disposition, "disposition") !== record.disposition ||
    (record.disposition === "accepted" ? requiredString(disposition, "kind") !== "accept" : requiredString(disposition, "kind") !== "reject")
  ) throw new RunDatabaseStateError("Experiment disposition is invalid");
  requiredArtifactRef(database, record.recordArtifact);
  const expectedBinding = stableHash({
    formatVersion: 1,
    candidateId: record.candidateId,
    candidateTreeHash: requiredString(candidate, "tree_hash"),
    measurementId: record.measurementId,
    measurementBindingHash: requiredString(measurement, "binding_hash"),
    dispositionOperationId: record.dispositionOperationId,
    disposition: record.disposition,
    metadata: record.metadata,
    learned: record.learned,
  });
  if (record.bindingHash !== expectedBinding) throw new TypeError("Experiment binding hash is invalid");
  database.prepare(`
    INSERT INTO experiments(
      experiment_id, run_id, operation_id, sequence, candidate_id, measurement_id,
      disposition_operation_id, disposition, metadata_json, learned, summary_json,
      binding_hash, record_artifact_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.experimentId, runId, operationId, record.sequence, record.candidateId, record.measurementId,
    record.dispositionOperationId, record.disposition,
    encodeCanonicalJson(record.metadata as unknown as JsonValue), record.learned,
    encodeCanonicalJson(record.summary as unknown as JsonValue), record.bindingHash,
    record.recordArtifact.digest, record.createdAt,
  );
}

export function readExperiment(database: DatabaseSync, experimentId: string): ExperimentRecord | undefined {
  assertIdentifier(experimentId, "experiment id");
  const row = database.prepare("SELECT * FROM experiments WHERE experiment_id = ?").get(experimentId) as SqlRow | undefined;
  if (!row) return undefined;
  const record: ExperimentRecord = {
    experimentId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    sequence: requiredNumber(row, "sequence"),
    candidateId: requiredString(row, "candidate_id"),
    measurementId: requiredString(row, "measurement_id"),
    dispositionOperationId: requiredString(row, "disposition_operation_id"),
    disposition: requiredString(row, "disposition") as ExperimentRecord["disposition"],
    metadata: decodeCanonicalJson(requiredString(row, "metadata_json")) as unknown as ExperimentRecord["metadata"],
    learned: requiredString(row, "learned"),
    summary: decodeCanonicalJson(requiredString(row, "summary_json")) as unknown as ExperimentRecord["summary"],
    bindingHash: requiredString(row, "binding_hash"),
    recordArtifact: artifactRef(database, requiredString(row, "record_artifact_digest")),
    createdAt: requiredString(row, "created_at"),
  };
  assertExperimentRecord(record);
  return record;
}

export function readExperimentByOperation(database: DatabaseSync, operationId: string): ExperimentRecord | undefined {
  assertIdentifier(operationId, "experiment operation id");
  const row = database.prepare("SELECT experiment_id FROM experiments WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
  return row ? readExperiment(database, requiredString(row, "experiment_id")) : undefined;
}

export function listExperiments(database: DatabaseSync, limit: number): ExperimentRecord[] {
  const rows = database.prepare("SELECT experiment_id FROM experiments ORDER BY sequence, experiment_id LIMIT ?")
    .all(pageLimit(limit)) as SqlRow[];
  return rows.map((row) => readExperiment(database, requiredString(row, "experiment_id"))!);
}

function measurementFromRow(database: DatabaseSync, row: SqlRow): MeasurementRecord {
  const measurementId = requiredString(row, "measurement_id");
  const definitions = (database.prepare(`
    SELECT o.metric_id, m.definition_json, m.definition_hash
    FROM measurement_observations o
    JOIN metrics m ON m.run_id = o.run_id AND m.metric_id = o.metric_id
    WHERE o.measurement_id = ? ORDER BY o.ordinal
  `).all(measurementId) as SqlRow[]).map((entry) => ({
    metricId: requiredString(entry, "metric_id"),
    definition: decodeCanonicalJson(requiredString(entry, "definition_json")),
    definitionHash: requiredString(entry, "definition_hash"),
  }));
  const observations = (database.prepare(
    "SELECT * FROM measurement_observations WHERE measurement_id = ? ORDER BY ordinal",
  ).all(measurementId) as SqlRow[]).map((entry) => ({
    observationId: requiredString(entry, "observation_id"),
    metricId: requiredString(entry, "metric_id"),
    outputId: requiredString(entry, "output_id"),
    value: requiredNumber(entry, "value"),
    samples: decodeCanonicalJson(requiredString(entry, "samples_json")),
    status: requiredString(entry, "initial_status"),
  }));
  const candidateId = optionalString(row, "candidate_id");
  const delta = normalizeMetricCohortDelta({
    formatVersion: 1,
    kind: "measurement-cohort",
    measurementId,
    operationPath: requiredString(
      database.prepare("SELECT path FROM operations WHERE operation_id = ?").get(requiredString(row, "operation_id")) as SqlRow,
      "path",
    ),
    profileId: requiredString(row, "profile_id"),
    profileHash: requiredString(row, "profile_hash"),
    environmentHash: requiredString(row, "environment_hash"),
    ...(candidateId ? {
      candidate: {
        candidateId,
        treeHash: requiredString(row, "workspace_tree_hash"),
        lineageHash: requiredString(row, "workspace_lineage_hash"),
      },
    } : {}),
    definitions,
    observations,
  });
  const record: MeasurementRecord = {
    measurementId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    ...(optionalString(row, "attempt_id") ? { attemptId: optionalString(row, "attempt_id")! } : {}),
    profileId: requiredString(row, "profile_id"),
    profileHash: requiredString(row, "profile_hash"),
    command: decodeCanonicalJson(requiredString(row, "command_json")) as unknown as MeasurementRecord["command"],
    commandHash: requiredString(row, "command_hash"),
    workspace: workspaceFromMeasurementRow(row),
    ...(candidateId ? { candidateId } : {}),
    sampling: decodeCanonicalJson(requiredString(row, "sampling_json")) as unknown as MeasurementRecord["sampling"],
    samplingHash: requiredString(row, "sampling_hash"),
    ...(optionalNumber(row, "cpu_affinity_physical_cores") !== undefined
      ? { cpuAffinity: { physicalCores: optionalNumber(row, "cpu_affinity_physical_cores")! } }
      : {}),
    environment: decodeCanonicalJson(requiredString(row, "environment_json")) as JsonObject,
    environmentHash: requiredString(row, "environment_hash"),
    bindingHash: requiredString(row, "binding_hash"),
    cohortArtifact: artifactRef(database, requiredString(row, "cohort_artifact_digest")),
    ...(optionalString(row, "diagnostics_artifact_digest")
      ? { diagnosticsArtifact: artifactRef(database, optionalString(row, "diagnostics_artifact_digest")!) }
      : {}),
    diagnostics: decodeCanonicalJson(requiredString(row, "diagnostics_json")) as unknown as MeasurementRecord["diagnostics"],
    samples: readSamples(database, measurementId),
    delta,
    startedAt: requiredString(row, "started_at"),
    endedAt: requiredString(row, "ended_at"),
  };
  assertMeasurementRecord(record);
  return record;
}

function readSamples(database: DatabaseSync, measurementId: string): MeasurementSampleRecord[] {
  return (database.prepare("SELECT * FROM measurement_samples WHERE measurement_id = ? ORDER BY ordinal")
    .all(measurementId) as SqlRow[]).map((row) => ({
      ordinal: requiredNumber(row, "ordinal"),
      kind: requiredString(row, "kind") as MeasurementSampleRecord["kind"],
      sampleIndex: requiredNumber(row, "sample_index"),
      executionId: requiredString(row, "execution_id"),
      status: requiredString(row, "status") as MeasurementSampleRecord["status"],
      exitCode: optionalNumber(row, "exit_code") ?? null,
      ...(optionalString(row, "signal") ? { signal: optionalString(row, "signal")! } : {}),
      timedOut: requiredNumber(row, "timed_out") === 1,
      stdout: artifactRef(database, requiredString(row, "stdout_artifact_digest")),
      stderr: artifactRef(database, requiredString(row, "stderr_artifact_digest")),
      ...(optionalString(row, "cgroup_json")
        ? { cgroup: decodeCanonicalJson(optionalString(row, "cgroup_json")!) as JsonObject }
        : {}),
      hostPressure: decodeCanonicalJson(requiredString(row, "host_psi_json")) as JsonObject,
      startedAt: requiredString(row, "started_at"),
      endedAt: requiredString(row, "ended_at"),
    }));
}

function readMetricStates(
  database: DatabaseSync,
  runId: string,
  afterMetricId?: string,
  limit?: number,
): PersistedMetricState[] {
  const rows = afterMetricId !== undefined || limit !== undefined
    ? database.prepare("SELECT * FROM metrics WHERE run_id = ? AND metric_id > ? ORDER BY metric_id LIMIT ?")
        .all(runId, afterMetricId ?? "", limit ?? 256) as SqlRow[]
    : database.prepare("SELECT * FROM metrics WHERE run_id = ? ORDER BY metric_id").all(runId) as SqlRow[];
  return rows.map((row) => {
    const metricId = requiredString(row, "metric_id");
    const definition = normalizeMetricDefinition(
      decodeCanonicalJson(requiredString(row, "definition_json")), metricId,
    );
    const observations = (database.prepare(`
      SELECT * FROM measurement_observations
      WHERE run_id = ? AND metric_id = ? ORDER BY sequence DESC LIMIT 16
    `).all(runId, metricId) as SqlRow[]).reverse().map(observationFromRow);
    return {
      metricId,
      definition,
      definitionHash: requiredString(row, "definition_hash"),
      role: requiredString(row, "role") as PersistedMetricState["role"],
      baseline: optionalNumber(row, "baseline") ?? null,
      current: optionalNumber(row, "current_value") ?? null,
      best: optionalNumber(row, "best") ?? null,
      relativeGain: optionalNumber(row, "relative_gain") ?? null,
      observationCount: requiredNumber(row, "observation_count"),
      ...(optionalString(row, "baseline_profile_id") ? { baselineProfileId: optionalString(row, "baseline_profile_id")! } : {}),
      ...(optionalString(row, "baseline_profile_hash") ? { baselineProfileHash: optionalString(row, "baseline_profile_hash")! } : {}),
      ...(optionalString(row, "baseline_environment_hash") ? { baselineEnvironmentHash: optionalString(row, "baseline_environment_hash")! } : {}),
      recentObservations: observations,
    };
  });
}

function observationFromRow(row: SqlRow): PersistedMetricObservation {
  return {
    sequence: requiredNumber(row, "sequence"),
    measurementId: requiredString(row, "measurement_id"),
    observationId: requiredString(row, "observation_id"),
    outputId: requiredString(row, "output_id"),
    value: requiredNumber(row, "value"),
    status: requiredString(row, "status") as PersistedMetricObservation["status"],
    bestReference: optionalNumber(row, "best_reference") ?? null,
    improvementPassed: nullableBoolean(row, "improvement_passed"),
    guardrailPassed: nullableBoolean(row, "guardrail_passed"),
  };
}

function measurementDispositionFromRow(row: SqlRow): MeasurementDispositionRecord {
  const disposition = requiredString(row, "disposition");
  if (disposition !== "accepted" && disposition !== "rejected") {
    throw new RunDatabaseCorruptionError("Measurement disposition is invalid");
  }
  const record: MeasurementDispositionRecord = {
    measurementId: requiredString(row, "measurement_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    candidateId: requiredString(row, "candidate_id"),
    disposition,
    disposedAt: requiredString(row, "disposed_at"),
  };
  assertIdentifier(record.measurementId, "measurement disposition id");
  assertIdentifier(record.runId, "measurement disposition run id");
  assertIdentifier(record.operationId, "measurement disposition operation id");
  assertIdentifier(record.candidateId, "measurement disposition candidate id");
  assertIsoDate(record.disposedAt, "measurement disposition time");
  return record;
}

function assertDispositionResult(
  value: Record<string, JsonValue>,
  disposition: "accepted" | "rejected",
  operationPath: string,
): void {
  if (value.formatVersion !== 2 || value.disposition !== disposition || value.operationPath !== operationPath) {
    throw new RunDatabaseStateError("Candidate disposition output changed semantic identity");
  }
  const recordHash = requiredStringValue(value.recordHash, "candidate disposition record hash");
  const receiptId = requiredStringValue(value.receiptId, "candidate disposition receipt id");
  assertHash(recordHash, "candidate disposition record hash");
  const semantic = { ...value };
  delete semantic.receiptId;
  delete semantic.recordHash;
  const prefix = disposition === "accepted" ? "acceptance" : "rejection";
  if (recordHash !== stableHash(semantic) || receiptId !== `${prefix}_${recordHash.slice(7, 39)}`) {
    throw new RunDatabaseStateError("Candidate disposition output has an invalid semantic hash");
  }
}

function assertDispositionCandidate(
  database: DatabaseSync,
  measurement: MeasurementRecord,
  value: JsonValue | undefined,
): void {
  if (!measurement.candidateId) throw new RunDatabaseStateError("Measurement disposition candidate is missing");
  const candidate = database.prepare(`
    SELECT tree_hash, lineage_hash, write_scope_hash FROM candidates
    WHERE candidate_id = ? AND run_id = ?
  `).get(measurement.candidateId, measurement.runId) as SqlRow | undefined;
  if (!candidate) throw new RunDatabaseStateError("Measurement disposition candidate is missing");
  const changedPaths = (database.prepare(
    "SELECT path FROM candidate_changed_paths WHERE candidate_id = ? ORDER BY ordinal",
  ).all(measurement.candidateId) as SqlRow[]).map((row) => requiredString(row, "path"));
  const body = {
    treeHash: requiredString(candidate, "tree_hash"),
    lineageHash: requiredString(candidate, "lineage_hash"),
    writeScopeHash: requiredString(candidate, "write_scope_hash"),
    changedPaths,
  };
  const expected = { ...body, authorityHash: stableHash(body) };
  if (stableHash(requiredRecord(value, "candidate disposition authority")) !== stableHash(expected)) {
    throw new RunDatabaseStateError("Candidate disposition changed its exact candidate authority");
  }
}

function optionalRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function requiredRecord(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  const record = optionalRecord(value);
  if (!record) throw new RunDatabaseStateError(`${label} must be an object`);
  return record;
}

function requiredStringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new RunDatabaseStateError(`${label} must be a string`);
  return value;
}

function upsertMetric(database: DatabaseSync, runId: string, metric: PersistedMetricState): void {
  database.prepare(`
    INSERT INTO metrics(
      run_id, metric_id, definition_json, definition_hash, role, baseline, current_value,
      best, relative_gain, observation_count, baseline_profile_id, baseline_profile_hash, baseline_environment_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, metric_id) DO UPDATE SET
      definition_json = excluded.definition_json, definition_hash = excluded.definition_hash,
      role = excluded.role, baseline = excluded.baseline, current_value = excluded.current_value,
      best = excluded.best, relative_gain = excluded.relative_gain,
      observation_count = excluded.observation_count, baseline_profile_id = excluded.baseline_profile_id,
      baseline_profile_hash = excluded.baseline_profile_hash,
      baseline_environment_hash = excluded.baseline_environment_hash
  `).run(
    runId, metric.metricId, encodeCanonicalJson(metric.definition as unknown as JsonValue), metric.definitionHash,
    metric.role, metric.baseline, metric.current, metric.best, metric.relativeGain, metric.observationCount,
    metric.baselineProfileId ?? null, metric.baselineProfileHash ?? null, metric.baselineEnvironmentHash ?? null,
  );
}

function insertSample(database: DatabaseSync, measurementId: string, sample: MeasurementSampleRecord): void {
  database.prepare(`
    INSERT INTO measurement_samples(
      measurement_id, ordinal, kind, sample_index, execution_id, status, exit_code, signal,
      timed_out, stdout_artifact_digest, stderr_artifact_digest, cgroup_json, host_psi_json,
      started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    measurementId, sample.ordinal, sample.kind, sample.sampleIndex, sample.executionId,
    sample.status, sample.exitCode, sample.signal ?? null, sample.timedOut ? 1 : 0,
    sample.stdout.digest, sample.stderr.digest,
    sample.cgroup ? encodeCanonicalJson(sample.cgroup) : null,
    encodeCanonicalJson(sample.hostPressure), sample.startedAt, sample.endedAt,
  );
}

function assertMeasurementRecord(record: MeasurementRecord): void {
  assertIdentifier(record.measurementId, "measurement id");
  assertIdentifier(record.runId, "measurement run id");
  assertIdentifier(record.operationId, "measurement operation id");
  if (record.attemptId) assertIdentifier(record.attemptId, "measurement attempt id");
  assertHash(record.profileHash, "measurement profile hash");
  assertHash(record.commandHash, "measurement command hash");
  assertHash(record.samplingHash, "measurement sampling hash");
  assertHash(record.environmentHash, "measurement environment hash");
  assertHash(record.bindingHash, "measurement binding hash");
  assertWorkspace(record.workspace);
  assertIsoDate(record.startedAt, "measurement startedAt");
  assertIsoDate(record.endedAt, "measurement endedAt");
  if (record.commandHash !== stableHash(record.command) || record.samplingHash !== stableHash(record.sampling)) {
    throw new TypeError("Measurement command or sampling hash is invalid");
  }
  if (record.environmentHash !== stableHash(record.environment) || record.bindingHash !== measurementBindingHash(record)) {
    throw new TypeError("Measurement environment or binding hash is invalid");
  }
  const delta = normalizeMetricCohortDelta(record.delta);
  if (
    delta.measurementId !== record.measurementId || delta.profileId !== record.profileId ||
    delta.profileHash !== record.profileHash || delta.environmentHash !== record.environmentHash
  ) throw new TypeError("Measurement metric cohort binding is invalid");
  if (Boolean(record.candidateId) !== (record.workspace.kind === "candidate")) {
    throw new TypeError("Measurement candidate workspace binding is invalid");
  }
  if (record.candidateId && (
    delta.candidate?.candidateId !== record.candidateId || delta.candidate.treeHash !== record.workspace.treeHash ||
    delta.candidate.lineageHash !== record.workspace.lineageHash
  )) throw new TypeError("Measurement metric cohort candidate is invalid");
  const expectedInvocations = record.sampling.warmups + record.sampling.samples;
  if (record.samples.length !== expectedInvocations || expectedInvocations < 1) throw new TypeError("Measurement sample cohort is incomplete");
  const mappings = record.sampling.mappings;
  if (
    mappings.length !== delta.definitions.length || mappings.some((mapping, index) =>
      mapping.metricId !== delta.observations[index]?.metricId || mapping.outputId !== delta.observations[index]?.outputId ||
      mapping.definitionHash !== delta.definitions[index]?.definitionHash)
  ) throw new TypeError("Measurement sampling mappings differ from observations");
  for (const [ordinal, sample] of record.samples.entries()) {
    if (sample.ordinal !== ordinal || sample.kind !== (ordinal < record.sampling.warmups ? "warmup" : "sample")) {
      throw new TypeError("Measurement invocation order is invalid");
    }
    const expectedIndex = sample.kind === "warmup" ? ordinal : ordinal - record.sampling.warmups;
    if (sample.sampleIndex !== expectedIndex) throw new TypeError("Measurement sample index is invalid");
    assertIsoDate(sample.startedAt, "measurement sample startedAt");
    assertIsoDate(sample.endedAt, "measurement sample endedAt");
  }
}

function assertExperimentRecord(record: ExperimentRecord): void {
  assertIdentifier(record.experimentId, "experiment id");
  assertIdentifier(record.runId, "experiment run id");
  assertIdentifier(record.operationId, "experiment operation id");
  assertIdentifier(record.candidateId, "experiment candidate id");
  assertIdentifier(record.measurementId, "experiment measurement id");
  assertIdentifier(record.dispositionOperationId, "experiment disposition operation id");
  assertHash(record.bindingHash, "experiment binding hash");
  assertIsoDate(record.createdAt, "experiment createdAt");
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new TypeError("Experiment sequence is invalid");
  normalizeExperimentCandidateMetadata(record.metadata);
  normalizeExperimentLearned(record.learned);
  if (record.disposition !== "accepted" && record.disposition !== "rejected") throw new TypeError("Experiment disposition is invalid");
  if (record.summary.experimentId !== record.experimentId || record.summary.candidateId !== record.candidateId || record.summary.disposition !== record.disposition) {
    throw new TypeError("Experiment summary binding is invalid");
  }
}

function assertCandidateBinding(database: DatabaseSync, record: MeasurementRecord): void {
  const candidate = database.prepare(`
    SELECT workspace_id, tree_hash, lineage_hash, write_scope_hash FROM candidates
    WHERE candidate_id = ? AND run_id = ?
  `).get(record.candidateId!, record.runId) as SqlRow | undefined;
  if (!candidate ||
    requiredString(candidate, "workspace_id") !== record.workspace.workspaceId ||
    requiredString(candidate, "tree_hash") !== record.workspace.treeHash ||
    requiredString(candidate, "lineage_hash") !== record.workspace.lineageHash ||
    requiredString(candidate, "write_scope_hash") !== record.workspace.writeScopeHash
  ) throw new RunDatabaseStateError("Measurement candidate binding differs from its frozen record");
}

function workspaceFromMeasurementRow(row: SqlRow): MeasurementRecord["workspace"] {
  const kind = requiredString(row, "workspace_kind") as MeasurementRecord["workspace"]["kind"];
  const workspace = {
    kind,
    workspaceId: requiredString(row, "workspace_id"),
    treeHash: requiredString(row, "workspace_tree_hash"),
    ...(optionalString(row, "workspace_lineage_hash") ? { lineageHash: optionalString(row, "workspace_lineage_hash")! } : {}),
    ...(optionalString(row, "workspace_write_scope_hash") ? { writeScopeHash: optionalString(row, "workspace_write_scope_hash")! } : {}),
  };
  assertWorkspace(workspace);
  return workspace;
}

function measurementArtifacts(record: MeasurementRecord): ArtifactRef[] {
  return [
    record.cohortArtifact,
    ...(record.diagnosticsArtifact ? [record.diagnosticsArtifact] : []),
    ...record.samples.flatMap((sample) => [sample.stdout, sample.stderr]),
  ];
}

function artifactRef(database: DatabaseSync, digest: string): ArtifactRef {
  const row = database.prepare("SELECT kind, media_type, bytes FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
  if (!row) throw new RunDatabaseCorruptionError(`Missing artifact ${digest}`);
  return {
    digest,
    kind: requiredString(row, "kind"),
    mediaType: requiredString(row, "media_type") as ArtifactRef["mediaType"],
    bytes: requiredNumber(row, "bytes"),
  };
}

function nullableBoolean(row: SqlRow, field: string): boolean | null {
  const value = optionalNumber(row, field);
  return value === undefined ? null : value === 1;
}

function booleanValue(value: boolean | null): number | null { return value === null ? null : value ? 1 : 0; }

function pageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new TypeError("Invalid measurement page limit");
  return value;
}
