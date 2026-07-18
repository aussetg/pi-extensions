import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { deepFreezeJson } from "./canonical-json.js";

export const WORKFLOW_RUNTIME_API_VERSION = 17 as const;
export const WORKFLOW_MODULE = "pi/workflows" as const;
export const WORKFLOW_SOURCE_EXTENSION = ".flow.ts" as const;

export const WORKFLOW_DESCRIPTOR_KINDS = Object.freeze([
  "agent-task",
  "command-task",
] as const);

export const WORKFLOW_PRODUCT_KINDS = Object.freeze([
  "artifact",
  "agent-result",
  "command-result",
  "candidate",
  "accepted-candidate",
  "verification",
  "measurement",
] as const);

export const WORKFLOW_REFERENCE_KINDS = Object.freeze([
  "launch-snapshot",
  "candidate-workspace",
  "metric-set",
] as const);

export const WORKFLOW_RESOURCE_KINDS = Object.freeze([
  "measurement-profile",
] as const);

export type WorkflowDescriptorKind = (typeof WORKFLOW_DESCRIPTOR_KINDS)[number];
export type WorkflowProductKind = (typeof WORKFLOW_PRODUCT_KINDS)[number];
export type WorkflowReferenceKind = (typeof WORKFLOW_REFERENCE_KINDS)[number];
export type WorkflowResourceKind = (typeof WORKFLOW_RESOURCE_KINDS)[number];

export interface WorkflowDescriptorIdentity {
  formatVersion: 1;
  kind: WorkflowDescriptorKind;
  sourceSite: string;
  definitionHash: string;
}

export interface WorkflowProductIdentity {
  formatVersion: 1;
  kind: WorkflowProductKind;
  authorityId: string;
  authorityHash: string;
}

export interface WorkflowResourceIdentity {
  formatVersion: 1;
  kind: WorkflowResourceKind;
  selector: string;
  snapshotHash: string;
}

export interface WorkflowReferenceIdentity {
  formatVersion: 1;
  kind: WorkflowReferenceKind;
  authorityId: string;
  authorityHash: string;
}

const HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
const ID_PATTERN = "^[a-z][a-z0-9-]{0,127}$";

export const WORKFLOW_DESCRIPTOR_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "sourceSite", "definitionHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_DESCRIPTOR_KINDS] },
    sourceSite: { type: "string", pattern: ID_PATTERN },
    definitionHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_PRODUCT_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "authorityId", "authorityHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_PRODUCT_KINDS] },
    authorityId: { type: "string", pattern: ID_PATTERN },
    authorityHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_REFERENCE_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "authorityId", "authorityHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_REFERENCE_KINDS] },
    authorityId: { type: "string", pattern: ID_PATTERN },
    authorityHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

export const WORKFLOW_RESOURCE_IDENTITY_SCHEMA = deepFreezeJson({
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "kind", "selector", "snapshotHash"],
  properties: {
    formatVersion: { const: 1 },
    kind: { enum: [...WORKFLOW_RESOURCE_KINDS] },
    selector: {
      type: "string",
      pattern: "^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$",
    },
    snapshotHash: { type: "string", pattern: HASH_PATTERN },
  },
} as unknown as JsonValue) as JsonSchema;

/**
 * Normative public-language identity pinned by snapshots, control protocol, and semantic engine.
 */
export const WORKFLOW_RUNTIME_API_DESCRIPTOR = deepFreezeJson({
  formatVersion: 1,
  runtimeApiVersion: WORKFLOW_RUNTIME_API_VERSION,
  source: {
    extension: WORKFLOW_SOURCE_EXTENSION,
    module: WORKFLOW_MODULE,
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
  descriptorKinds: [...WORKFLOW_DESCRIPTOR_KINDS],
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
  productKinds: [...WORKFLOW_PRODUCT_KINDS],
  referenceKinds: [...WORKFLOW_REFERENCE_KINDS],
  resourceKinds: [...WORKFLOW_RESOURCE_KINDS],
  authorityIdentitySchemas: {
    descriptor: WORKFLOW_DESCRIPTOR_IDENTITY_SCHEMA,
    product: WORKFLOW_PRODUCT_IDENTITY_SCHEMA,
    reference: WORKFLOW_REFERENCE_IDENTITY_SCHEMA,
    resource: WORKFLOW_RESOURCE_IDENTITY_SCHEMA,
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

export const WORKFLOW_RUNTIME_API_HASH = stableHash(WORKFLOW_RUNTIME_API_DESCRIPTOR);
