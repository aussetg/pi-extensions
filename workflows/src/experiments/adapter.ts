import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import { describeOpaqueCandidateRef } from "../candidates/refs.js";
import { candidateAuthorityBinding } from "../candidates/disposition.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { OperationRecord } from "../runtime/durable-types.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
} from "../runtime/semantic-engine-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  normalizeExperimentCandidateMetadata,
  normalizeExperimentLearned,
  type ExperimentCandidateMetadata,
  type ExperimentRecord,
  type ExperimentSummary,
} from "./records.js";

export interface SemanticExperimentAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  now?: () => Date;
}

interface ResolvedExperiment {
  candidateId: string;
  candidateTreeHash: string;
  candidateLogicalPath: string;
  metadata: ExperimentCandidateMetadata;
  measurementId: string;
  measurementBindingHash: string;
  dispositionOperationId: string;
  disposition: "accepted" | "rejected";
  learned: string;
  semanticInput: JsonValue;
}

/** Pure record effect. Candidate/disposition production remains owned by the Phase 22 adapters. */
export class SemanticExperimentAdapter implements SemanticEffectAdapter {
  readonly kind = "record-experiment" as const;
  private readonly store: ArtifactStore;
  private readonly now: () => Date;
  private readonly admissions = new Map<string, ResolvedExperiment>();

  constructor(private readonly options: SemanticExperimentAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new ArtifactStore(options.runDir, options.database, {
      maximumArtifactBytes: options.database.readRun().safety.outputBytes,
      now: this.now,
    });
    if (path.resolve(options.database.databasePath) !== path.join(path.resolve(options.runDir), "run.sqlite")) {
      throw new Error("Experiment adapter and run database directories differ");
    }
  }

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    return this.resolve(request).semanticInput;
  }

  journalIdentity(request: SemanticEffectAdmissionRequest): SemanticEffectJournalIdentity {
    const resolved = this.resolve(request);
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "experiment-record",
        semanticInput: resolved.semanticInput,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "never",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = this.resolve(request);
    const sequence = request.database.listExperiments(DEFINITION_LIMITS.experiments).length + 1;
    if (sequence > DEFINITION_LIMITS.experiments) throw new Error("Run exceeds its experiment bound");
    const experimentId = `experiment_${stableHash({
      formatVersion: 1, runId: request.run.runId, path: request.path, candidateId: resolved.candidateId,
    }).slice(7, 39)}`;
    const summary = this.summary(experimentId, resolved);
    const bindingHash = stableHash({
      formatVersion: 1,
      candidateId: resolved.candidateId,
      candidateTreeHash: resolved.candidateTreeHash,
      measurementId: resolved.measurementId,
      measurementBindingHash: resolved.measurementBindingHash,
      dispositionOperationId: resolved.dispositionOperationId,
      disposition: resolved.disposition,
      metadata: resolved.metadata,
      learned: resolved.learned,
    });
    const createdAt = this.now().toISOString();
    const body = {
      formatVersion: 1,
      experimentId,
      runId: request.run.runId,
      operationPath: request.path,
      sequence,
      candidateId: resolved.candidateId,
      candidateTreeHash: resolved.candidateTreeHash,
      measurementId: resolved.measurementId,
      measurementBindingHash: resolved.measurementBindingHash,
      dispositionOperationId: resolved.dispositionOperationId,
      disposition: resolved.disposition,
      metadata: resolved.metadata,
      learned: resolved.learned,
      summary,
      bindingHash,
      createdAt,
    };
    const recordArtifact = (await this.store.putJson({
      expectedRevision: request.database.readRun().revision,
      kind: "experiment-record",
      value: body as unknown as JsonValue,
      metadata: {},
      maximumBytes: DEFINITION_LIMITS.experimentRecordBytes,
      createdAt,
    })).artifact;
    const record: ExperimentRecord = {
      experimentId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      sequence,
      candidateId: resolved.candidateId,
      measurementId: resolved.measurementId,
      dispositionOperationId: resolved.dispositionOperationId,
      disposition: resolved.disposition,
      metadata: resolved.metadata,
      learned: resolved.learned,
      summary,
      bindingHash,
      recordArtifact,
      createdAt,
    };
    return {
      result: { value: summary as unknown as JsonValue, artifacts: [recordArtifact] },
      experiment: record,
      completionAuthority: "host-effect",
    };
  }

  restore(request: SemanticEffectRestoreRequest): unknown {
    const record = request.database.readExperimentByOperation(request.operation.operationId);
    if (!record) throw new Error(`Completed experiment ${request.path} has no SQLite record`);
    return structuredClone(record.summary);
  }

  private resolve(request: SemanticEffectAdmissionRequest): ResolvedExperiment {
    const cached = this.admissions.get(request.path);
    if (cached) return cached;
    const input = plainRecord(request.input, "flow.recordExperiment options");
    exactKeys(input, new Set(["candidate", "measurement", "learned"]), "flow.recordExperiment options");
    const produced = plainRecord(input.candidate, "experiment candidate product");
    exactKeys(produced, new Set(["candidate", "metadata", "changedPaths"]), "experiment candidate product");
    const candidateRef = describeOpaqueCandidateRef(produced.candidate);
    if (!candidateRef || candidateRef.runId !== request.run.runId) throw new TypeError("Experiment candidate is not from this run");
    const candidate = this.options.database.readCandidate(candidateRef.candidateId);
    if (!candidate || candidate.workspace.treeHash !== candidateRef.treeHash || candidate.workspace.lineageHash !== candidateRef.lineageHash) {
      throw new TypeError("Experiment candidate reference is stale");
    }
    const metadata = normalizeExperimentCandidateMetadata(produced.metadata);
    const measurementInput = plainRecord(input.measurement, "experiment measurement");
    if (typeof measurementInput.measurementId !== "string") throw new TypeError("Experiment measurement id is missing");
    const measurement = this.options.database.readMeasurement(measurementInput.measurementId);
    if (!measurement || measurement.candidateId !== candidate.candidateId || measurement.workspace.treeHash !== candidate.workspace.treeHash) {
      throw new TypeError("Experiment measurement is not bound to its candidate");
    }
    assertMeasurementValue(measurementInput, measurement.delta.observations);
    const disposition = this.findDisposition(
      candidateAuthorityBinding(candidate).authorityHash,
      measurement.bindingHash,
    );
    const learned = normalizeExperimentLearned(input.learned);
    const resolved: ResolvedExperiment = {
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      candidateLogicalPath: candidateRef.logicalPath,
      metadata,
      measurementId: measurement.measurementId,
      measurementBindingHash: measurement.bindingHash,
      dispositionOperationId: disposition.operationId,
      disposition: disposition.kind === "accept" ? "accepted" : "rejected",
      learned,
      semanticInput: {
        candidateId: candidate.candidateId,
        candidateTreeHash: candidate.workspace.treeHash,
        metadata,
        measurementId: measurement.measurementId,
        measurementBindingHash: measurement.bindingHash,
        dispositionOperationId: disposition.operationId,
        disposition: disposition.kind === "accept" ? "accepted" : "rejected",
        learned,
      } as unknown as JsonValue,
    };
    this.admissions.set(request.path, resolved);
    return resolved;
  }

  private findDisposition(
    candidateAuthorityHash: string,
    measurementBindingHash: string,
  ): OperationRecord & { kind: "accept" | "reject" } {
    const operations: OperationRecord[] = [];
    let afterOrdinal = -1;
    while (true) {
      const page = this.options.database.listOperations({ afterOrdinal, limit: 256 });
      operations.push(...page);
      if (page.length < 256) break;
      afterOrdinal = page.at(-1)!.ordinal;
    }
    const matching = operations.filter((operation): operation is OperationRecord & { kind: "accept" | "reject" } => {
      if ((operation.kind !== "accept" && operation.kind !== "reject") || operation.status !== "completed") return false;
      const value = operation.result?.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value.candidate;
      const measurement = value.measurement;
      return Boolean(
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && measurement && typeof measurement === "object" && !Array.isArray(measurement)
        && candidate.authorityHash === candidateAuthorityHash
        && measurement.bindingHash === measurementBindingHash,
      );
    });
    if (matching.length !== 1) throw new Error("Experiment requires one exact completed candidate disposition");
    return matching[0]!;
  }

  private summary(experimentId: string, resolved: ResolvedExperiment): ExperimentSummary {
    const measurement = this.options.database.readMeasurement(resolved.measurementId)!;
    const definitions = new Map(measurement.delta.definitions.map((entry) => [entry.metricId, entry.definition]));
    const primaryObservation = measurement.delta.observations.find((observation) => definitions.get(observation.metricId)?.primary);
    const primaryState = primaryObservation ? this.options.database.readMetric(primaryObservation.metricId) : undefined;
    const primaryDefinition = primaryObservation ? definitions.get(primaryObservation.metricId) : undefined;
    const reference = primaryState?.best;
    const absolute = primaryObservation && primaryDefinition && reference !== null && reference !== undefined
      ? (primaryDefinition.direction === "maximize" ? primaryObservation.value - reference : reference - primaryObservation.value)
      : undefined;
    const iteration = iterationFromPath(resolved.candidateLogicalPath);
    return {
      experimentId,
      candidateId: resolved.candidateId,
      ...(iteration !== undefined ? { iteration } : {}),
      disposition: resolved.disposition,
      hypothesis: resolved.metadata.hypothesis,
      ...(primaryObservation ? {
        primary: {
          metricId: primaryObservation.metricId,
          value: primaryObservation.value,
          relativeChange: reference === null || reference === undefined || reference === 0 || absolute === undefined
            ? null : absolute / Math.abs(reference),
        },
      } : {}),
      guardrails: measurement.delta.observations.flatMap((observation) => {
        const definition = definitions.get(observation.metricId);
        if (!definition?.guardrail) return [];
        const state = this.options.database.readMetric(observation.metricId);
        const persisted = state?.recentObservations.find((entry) => entry.observationId === observation.observationId);
        if (persisted?.guardrailPassed === null || persisted?.guardrailPassed === undefined) {
          throw new Error(`Experiment guardrail ${observation.metricId} has no deterministic result`);
        }
        return [{ metricId: observation.metricId, value: observation.value, passed: persisted.guardrailPassed }];
      }),
      diagnostics: structuredClone(measurement.diagnostics),
      learned: resolved.learned,
      nextFocus: resolved.metadata.nextFocus,
    };
  }
}

function assertMeasurementValue(value: Record<string, unknown>, observations: readonly { observationId: string; outputId: string }[]): void {
  const supplied = value.observation
    ? [plainRecord(value.observation, "measurement observation")]
    : value.observations && typeof value.observations === "object" && !Array.isArray(value.observations)
      ? Object.values(value.observations).map((entry) => plainRecord(entry, "measurement observation"))
      : [];
  const expected = [...observations].map((observation) => `${observation.outputId}:${observation.observationId}`).sort();
  const actual = supplied.map((observation) => `${String(observation.outputId)}:${String(observation.observationId)}`).sort();
  if (expected.join("\0") !== actual.join("\0")) throw new TypeError("Experiment measurement observations were forged or mixed");
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}

function iterationFromPath(value: string): number | undefined {
  const matches = [...value.matchAll(/(?:^|\/)iteration:([0-9]+)(?:\/|$)/g)];
  return matches.length ? Number(matches.at(-1)![1]) : undefined;
}

