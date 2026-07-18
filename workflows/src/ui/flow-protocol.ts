import type { JsonObject, JsonValue } from "../types.js";
import { stableJson } from "../utils/stable-json.js";
import { stableHash } from "../utils/hashes.js";
import type { WorkflowRunProjection } from "../projection/types.js";

export const FLOW_PROTOCOL_MAX_BYTES = 256 * 1024;

export interface FlowChallengeProjection {
  kind: "ask-response" | "apply-approval" | "apply-rejection" | "run-deletion";
  runId: string;
  shortRunId: string;
  revision: number;
  token: string;
  summary: string;
  request?: JsonObject;
}

export interface FlowProtocolEnvelope {
  formatVersion: 1;
  kind: string;
  ok: boolean;
  at: string;
  message: string;
  projection?: WorkflowRunProjection;
  challenge?: FlowChallengeProjection;
  data?: JsonValue;
  error?: { name: string; message: string };
}

export interface FlowToolResultDetails {
  formatVersion?: 1;
  runId?: string;
  projection?: WorkflowRunProjection;
  resultPreview?: string;
  handoff?: boolean;
  challenge?: FlowChallengeProjection;
  error?: { name: string; message: string };
}

export function createFlowEnvelope(input: Omit<FlowProtocolEnvelope, "formatVersion" | "at">): FlowProtocolEnvelope {
  const envelope: FlowProtocolEnvelope = { formatVersion: 1, at: new Date().toISOString(), ...input };
  const bytes = Buffer.byteLength(stableJson(envelope));
  if (bytes <= FLOW_PROTOCOL_MAX_BYTES) return Object.freeze(envelope);
  let bounded: FlowProtocolEnvelope = {
    formatVersion: 1,
    kind: envelope.kind,
    ok: envelope.ok,
    at: envelope.at,
    message: `${envelope.message} · oversized detail omitted`,
    ...(envelope.challenge ? { challenge: envelope.challenge } : {}),
    ...(!envelope.challenge && envelope.projection ? { projection: envelope.projection } : {}),
    ...(!envelope.ok && envelope.error ? { error: envelope.error } : {}),
  };
  if (Buffer.byteLength(stableJson(bounded)) > FLOW_PROTOCOL_MAX_BYTES) {
    if (bounded.challenge?.request) {
      bounded = {
        ...bounded,
        challenge: {
          ...bounded.challenge,
          request: { omitted: true, hash: stableHash(bounded.challenge.request), reason: "challenge request exceeds protocol page bound" },
        },
      };
    }
    delete bounded.projection;
  }
  if (Buffer.byteLength(stableJson(bounded)) > FLOW_PROTOCOL_MAX_BYTES) {
    bounded = {
      formatVersion: 1,
      kind: envelope.kind,
      ok: false,
      at: envelope.at,
      message: "Flow protocol projection exceeded its byte bound",
      error: { name: "FlowProjectionLimitError", message: `Projection exceeded ${FLOW_PROTOCOL_MAX_BYTES} bytes` },
    };
  }
  return Object.freeze(bounded);
}

export function flowEnvelopeJson(envelope: FlowProtocolEnvelope): string {
  const text = stableJson(envelope);
  if (Buffer.byteLength(text) > FLOW_PROTOCOL_MAX_BYTES) throw new Error("Flow protocol envelope exceeds its byte bound");
  return text;
}

export function boundFlowToolResultDetails(details: FlowToolResultDetails): FlowToolResultDetails {
  if (Buffer.byteLength(stableJson(details)) <= FLOW_PROTOCOL_MAX_BYTES) return details;
  let bounded: FlowToolResultDetails = { ...details };
  delete bounded.resultPreview;
  if (bounded.challenge?.request) {
    bounded.challenge = {
      ...bounded.challenge,
      request: { omitted: true, hash: stableHash(bounded.challenge.request), reason: "challenge request exceeds tool-detail bound" },
    };
  }
  if (Buffer.byteLength(stableJson(bounded)) > FLOW_PROTOCOL_MAX_BYTES) delete bounded.challenge;
  if (Buffer.byteLength(stableJson(bounded)) > FLOW_PROTOCOL_MAX_BYTES) {
    bounded = {
      formatVersion: 1,
      ...(details.runId ? { runId: details.runId } : {}),
      ...(details.projection ? { projection: details.projection } : {}),
      error: { name: "FlowProjectionLimitError", message: "Tool details exceeded their serialized byte bound" },
    };
  }
  return bounded;
}
