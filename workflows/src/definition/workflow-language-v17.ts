import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { deepFreezeJson } from "./canonical-json.js";

export const WORKFLOW_V17_RUNTIME_API_VERSION = 17 as const;
export const WORKFLOW_V17_MODULE = "pi/workflows" as const;
export const WORKFLOW_V17_SOURCE_EXTENSION = ".flow.ts" as const;

export const WORKFLOW_V17_DESCRIPTOR_KINDS = Object.freeze([
  "agent-task",
  "command-task",
] as const);

export const WORKFLOW_V17_PRODUCT_KINDS = Object.freeze([
  "artifact",
  "agent-result",
  "command-result",
  "candidate",
  "accepted-candidate",
  "verification",
  "measurement",
] as const);

export const WORKFLOW_V17_REFERENCE_KINDS = Object.freeze([
  "launch-snapshot",
  "candidate-workspace",
  "metric-set",
] as const);

export const WORKFLOW_V17_RESOURCE_KINDS = Object.freeze([
  "measurement-profile",
] as const);

export type WorkflowV17DescriptorKind = (typeof WORKFLOW_V17_DESCRIPTOR_KINDS)[number];
export type WorkflowV17ProductKind = (typeof WORKFLOW_V17_PRODUCT_KINDS)[number];
export type WorkflowV17ReferenceKind = (typeof WORKFLOW_V17_REFERENCE_KINDS)[number];
export type WorkflowV17ResourceKind = (typeof WORKFLOW_V17_RESOURCE_KINDS)[number];

export interface WorkflowV17DescriptorIdentity {
  formatVersion: 1;
  kind: WorkflowV17DescriptorKind;
  sourceSite: string;
  definitionHash: string;
}

export interface WorkflowV17ProductIdentity {
  formatVersion: 1;
  kind: WorkflowV17ProductKind;
  authorityId: string;
  authorityHash: string;
}

export interface WorkflowV17ResourceIdentity {
  formatVersion: 1;
  kind: WorkflowV17ResourceKind;
  selector: string;
  snapshotHash: string;
}

export interface WorkflowV17ReferenceIdentity {
  formatVersion: 1;
  kind: WorkflowV17ReferenceKind;
  authorityId: string;
  authorityHash: string;
}

const HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
const ID_PATTERN = "^[a-z][a-z0-9-]{0,127}$";

export const WORKFLOW_V17_DESCRIPTOR_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "sourceSite", "definitionHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_V17_DESCRIPTOR_KINDS] },
    sourceSite: { type: "string", pattern: ID_PATTERN },
    definitionHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_V17_PRODUCT_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "authorityId", "authorityHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_V17_PRODUCT_KINDS] },
    authorityId: { type: "string", pattern: ID_PATTERN },
    authorityHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_V17_REFERENCE_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "authorityId", "authorityHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_V17_REFERENCE_KINDS] },
    authorityId: { type: "string", pattern: ID_PATTERN },
    authorityHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_V17_RESOURCE_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "selector", "snapshotHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_V17_RESOURCE_KINDS] },
    selector: {
      type: "string",
      pattern: "^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$",
    },
    snapshotHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

/**
 * Normative public-language identity. The v16 runtime does not consume this yet; the v17 frontend,
 * snapshots, control protocol, and semantic engine must all pin this exact descriptor at cutover.
 */
export const WORKFLOW_V17_RUNTIME_API_DESCRIPTOR = deepFreezeJson({
  formatVersion: 1,
  runtimeApiVersion: WORKFLOW_V17_RUNTIME_API_VERSION,
  source: {
    extension: WORKFLOW_V17_SOURCE_EXTENSION,
    module: WORKFLOW_V17_MODULE,
    typescript: "erasable-only",
    installedIdentity: "namespace-and-filename",
    exposure: "registry-policy",
    authority: "statically-derived",
  },
  definitionFields: [
    "title",
    "description",
    "input",
    "output",
    "concurrency",
    "run",
  ],
  schemaConstructors: [
    "string",
    "number",
    "integer",
    "boolean",
    "literal",
    "enum",
    "nullable",
    "optional",
    "array",
    "object",
    "union",
    "record",
    "id",
    "safePath",
    "json",
    "measurementProfile",
    "raw",
  ],
  descriptorConstructors: ["agent", "command"],
  descriptorKinds: [...WORKFLOW_V17_DESCRIPTOR_KINDS],
  structuredOperations: ["parallel", "map", "candidate"],
  durableOperations: [
    "agent",
    "command",
    "ask",
    "measure",
    "verify",
    "accept",
    "reject",
    "recordExperiment",
    "apply",
  ],
  synchronousOperations: ["metrics"],
  productKinds: [...WORKFLOW_V17_PRODUCT_KINDS],
  referenceKinds: [...WORKFLOW_V17_REFERENCE_KINDS],
  resourceKinds: [...WORKFLOW_V17_RESOURCE_KINDS],
  authorityIdentitySchemas: {
    descriptor: WORKFLOW_V17_DESCRIPTOR_IDENTITY_SCHEMA,
    product: WORKFLOW_V17_PRODUCT_IDENTITY_SCHEMA,
    reference: WORKFLOW_V17_REFERENCE_IDENTITY_SCHEMA,
    resource: WORKFLOW_V17_RESOURCE_IDENTITY_SCHEMA,
  },
  authorityTransport: {
    products: "explicit-branded-wire-variant",
    resourceResolution: "trusted-registry-at-launch",
  },
  operationIdentity: {
    sequential: "runtime-scope-encounter-cursor",
    concurrent: "parent-prefix-and-keyed-child-lane",
    join: "deterministic-structural-hash",
    displayMetadataSemantic: false,
  },
  concurrency: {
    methods: ["parallel", "map"],
    errors: ["fail-fast", "collect"],
    directPromiseConcurrency: false,
  },
  candidates: {
    verificationBoundAcceptance: true,
    acceptedCandidateOwnsEvidence: true,
    applyRequiresAcceptedCandidate: true,
    successfulRunAllowsPendingNonemptyCandidate: false,
  },
  removedOperations: [
    "stage",
    "loop",
    "fanOut",
    "checkpoint",
    "metric",
  ],
  removedAuthorFields: [
    "name",
    "inputSchema",
    "outputSchema",
    "capabilities",
    "modelVisible",
    "maxParallelism",
  ],
  removedInvocationFields: ["operationId", "resultMode", "argv", "model", "thinking"],
} as unknown as JsonValue);

export const WORKFLOW_V17_RUNTIME_API_HASH = stableHash(WORKFLOW_V17_RUNTIME_API_DESCRIPTOR);
