import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { ArtifactRef } from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";

export interface ExperimentCandidateMetadata {
  hypothesis: string;
  changeSummary: string;
  expectedEffect: string;
  nextFocus: string;
}

export interface ExperimentSummary {
  experimentId: string;
  candidateId: string;
  iteration?: number;
  disposition: "accepted" | "rejected";
  hypothesis: string;
  primary?: { metricId: string; value: number; relativeChange: number | null };
  guardrails: Array<{ metricId: string; value: number; passed: boolean }>;
  diagnostics: Array<{ sample: number; data: import("../types.js").JsonObject }>;
  learned: string;
  nextFocus: string;
}

export interface ExperimentRecord {
  experimentId: string;
  runId: string;
  operationId: string;
  sequence: number;
  candidateId: string;
  measurementId: string;
  dispositionOperationId: string;
  disposition: "accepted" | "rejected";
  metadata: ExperimentCandidateMetadata;
  learned: string;
  summary: ExperimentSummary;
  bindingHash: string;
  recordArtifact: ArtifactRef;
  createdAt: string;
}

export function normalizeExperimentCandidateMetadata(value: unknown): ExperimentCandidateMetadata {
  const canonical = canonicalJsonObject(value, experimentJsonLimits()) as unknown as ExperimentCandidateMetadata;
  const keys = Object.keys(canonical).sort();
  const expected = ["changeSummary", "expectedEffect", "hypothesis", "nextFocus"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Experiment candidate metadata must use the fixed optimize schema");
  }
  for (const [key, maximum] of [
    ["hypothesis", 1_000], ["changeSummary", 2_000], ["expectedEffect", 1_000], ["nextFocus", 1_000],
  ] as const) {
    const text = canonical[key];
    if (typeof text !== "string" || text.trim() === "" || Array.from(text).length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error(`Experiment metadata ${key} must contain 1–${maximum} safe Unicode scalars`);
    }
  }
  return deepFreezeJson(canonical as unknown as JsonValue) as unknown as ExperimentCandidateMetadata;
}

export function normalizeExperimentLearned(value: unknown): string {
  if (
    typeof value !== "string" || value.trim() === "" ||
    Array.from(value).length > DEFINITION_LIMITS.experimentLearnedScalars || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`Experiment learned must contain 1–${DEFINITION_LIMITS.experimentLearnedScalars} safe Unicode scalars`);
  return value;
}

function experimentJsonLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.experimentRecordBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}
