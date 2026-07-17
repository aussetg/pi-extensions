import type {
  WorkflowV17DescriptorIdentity,
  WorkflowV17ProductIdentity,
  WorkflowV17ReferenceIdentity,
} from "../definition/workflow-language-v17.js";
import {
  WORKFLOW_V17_DESCRIPTOR_KINDS,
  WORKFLOW_V17_PRODUCT_KINDS,
  WORKFLOW_V17_REFERENCE_KINDS,
} from "../definition/workflow-language-v17.js";
import type { WorkflowV17Descriptor } from "../definition/workflow-v17-types.js";
import { stableHash } from "../utils/hashes.js";

export type WorkflowV17ControlAuthorityFamily = "descriptor" | "product" | "reference";

export interface WorkflowV17ControlAuthorityDescription {
  family: WorkflowV17ControlAuthorityFamily;
  identity: WorkflowV17DescriptorIdentity | WorkflowV17ProductIdentity | WorkflowV17ReferenceIdentity;
  fields: Readonly<Record<string, unknown>>;
  privateAuthority?: unknown;
}

interface AuthorityRecord extends WorkflowV17ControlAuthorityDescription {
  owner: object;
  value: object;
  active: boolean;
  key: string;
}

const AUTHORITY_VALUES = new WeakMap<object, AuthorityRecord>();
const HASH = /^sha256:[a-f0-9]{64}$/u;
const AUTHORITY_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const SOURCE_SITE = /^[a-z][a-z0-9-]{0,127}$/u;
const FORBIDDEN_KEYS = new Set(["constructor", "prototype", "__proto__"]);

/**
 * One host-side authority scope. Values from another run/definition remain recognizable but are
 * rejected rather than silently degrading to structurally similar plain data.
 */
export class WorkflowV17ControlAuthorityRegistry {
  readonly scopeId: string;
  readonly #owner = Object.freeze(Object.create(null) as object);
  readonly #records = new Map<string, AuthorityRecord>();

  constructor(scopeId: string) {
    if (typeof scopeId !== "string" || scopeId.length < 1 || scopeId.length > 256 || /[\u0000-\u001f\u007f]/u.test(scopeId)) {
      throw new TypeError("Workflow v17 authority scope id is invalid");
    }
    this.scopeId = scopeId;
  }

  descriptor(descriptor: WorkflowV17Descriptor): object {
    assertDescriptorIdentity(descriptor.identity);
    if (descriptor.kind !== descriptor.identity.kind) {
      throw new TypeError("Workflow v17 descriptor kind differs from its authority identity");
    }
    const key = authorityKey("descriptor", descriptor.identity);
    const existing = this.#records.get(key);
    if (existing) {
      if (!existing.active || stableHash(existing.privateAuthority) !== stableHash(descriptor)) {
        throw new TypeError(`Workflow v17 descriptor authority ${descriptor.identity.sourceSite} changed`);
      }
      return existing.value;
    }
    return this.#create("descriptor", descriptor.identity, {}, descriptor);
  }

  product(
    identity: WorkflowV17ProductIdentity,
    fields: Readonly<Record<string, unknown>> = {},
    privateAuthority?: unknown,
  ): object {
    assertProductIdentity(identity);
    return this.#create("product", identity, fields, privateAuthority);
  }

  reference(
    identity: WorkflowV17ReferenceIdentity,
    fields: Readonly<Record<string, unknown>> = {},
    privateAuthority?: unknown,
  ): object {
    assertReferenceIdentity(identity);
    return this.#create("reference", identity, fields, privateAuthority);
  }

  describe(value: unknown): WorkflowV17ControlAuthorityDescription | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = AUTHORITY_VALUES.get(value);
    if (!record) return undefined;
    this.#assertOwned(record);
    return description(record);
  }

  /** Used by the wire encoder so foreign and revoked authority fails closed. */
  transport(value: object): WorkflowV17ControlAuthorityDescription | undefined {
    const record = AUTHORITY_VALUES.get(value);
    if (!record) return undefined;
    this.#assertOwned(record);
    return description(record);
  }

  revoke(value: unknown): void {
    if (!value || typeof value !== "object") throw new TypeError("Workflow v17 authority value is invalid");
    const record = AUTHORITY_VALUES.get(value);
    if (!record) throw new TypeError("Workflow v17 value has no authority");
    this.#assertOwned(record);
    record.active = false;
  }

  #create(
    family: WorkflowV17ControlAuthorityFamily,
    identity: WorkflowV17ControlAuthorityDescription["identity"],
    fieldsValue: Readonly<Record<string, unknown>>,
    privateAuthority?: unknown,
  ): object {
    const key = authorityKey(family, identity);
    if (this.#records.has(key)) throw new TypeError(`Duplicate workflow v17 ${family} authority ${key}`);
    const fields = copyFields(fieldsValue);
    const value = Object.create(null) as Record<string, unknown>;
    for (const [name, field] of Object.entries(fields)) {
      Object.defineProperty(value, name, {
        value: field,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(value);
    const record: AuthorityRecord = {
      owner: this.#owner,
      family,
      identity: structuredClone(identity),
      fields,
      ...(privateAuthority !== undefined ? { privateAuthority } : {}),
      value,
      active: true,
      key,
    };
    AUTHORITY_VALUES.set(value, record);
    this.#records.set(key, record);
    return value;
  }

  #assertOwned(record: AuthorityRecord): void {
    if (record.owner !== this.#owner) {
      throw new WorkflowV17AuthorityScopeError(
        `Workflow v17 authority belongs to another scope, not ${this.scopeId}`,
      );
    }
    if (!record.active) throw new WorkflowV17StaleAuthorityError("Workflow v17 authority has been revoked");
  }
}

export class WorkflowV17AuthorityScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17AuthorityScopeError";
  }
}

export class WorkflowV17StaleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17StaleAuthorityError";
  }
}

export function isWorkflowV17ControlAuthority(value: unknown): value is object {
  return Boolean(value) && typeof value === "object" && AUTHORITY_VALUES.has(value as object);
}

export function assertDescriptorIdentity(value: WorkflowV17DescriptorIdentity): void {
  if (!plainRecord(value) || value.formatVersion !== 1
    || !WORKFLOW_V17_DESCRIPTOR_KINDS.includes(value.kind as never)
    || typeof value.sourceSite !== "string" || !SOURCE_SITE.test(value.sourceSite)
    || typeof value.definitionHash !== "string" || !HASH.test(value.definitionHash)
    || !exactKeys(value, ["formatVersion", "kind", "sourceSite", "definitionHash"])) {
    throw new TypeError("Workflow v17 descriptor identity is invalid");
  }
}

export function assertProductIdentity(value: WorkflowV17ProductIdentity): void {
  if (!plainRecord(value) || value.formatVersion !== 1
    || !WORKFLOW_V17_PRODUCT_KINDS.includes(value.kind as never)
    || typeof value.authorityId !== "string" || !AUTHORITY_ID.test(value.authorityId)
    || typeof value.authorityHash !== "string" || !HASH.test(value.authorityHash)
    || !exactKeys(value, ["formatVersion", "kind", "authorityId", "authorityHash"])) {
    throw new TypeError("Workflow v17 product identity is invalid");
  }
}

export function assertReferenceIdentity(value: WorkflowV17ReferenceIdentity): void {
  if (!plainRecord(value) || value.formatVersion !== 1
    || !WORKFLOW_V17_REFERENCE_KINDS.includes(value.kind as never)
    || typeof value.authorityId !== "string" || !AUTHORITY_ID.test(value.authorityId)
    || typeof value.authorityHash !== "string" || !HASH.test(value.authorityHash)
    || !exactKeys(value, ["formatVersion", "kind", "authorityId", "authorityHash"])) {
    throw new TypeError("Workflow v17 reference identity is invalid");
  }
}

function description(record: AuthorityRecord): WorkflowV17ControlAuthorityDescription {
  return {
    family: record.family,
    identity: structuredClone(record.identity),
    fields: record.fields,
    ...(record.privateAuthority !== undefined ? { privateAuthority: record.privateAuthority } : {}),
  };
}

function authorityKey(
  family: WorkflowV17ControlAuthorityFamily,
  identity: WorkflowV17ControlAuthorityDescription["identity"],
): string {
  const id = family === "descriptor"
    ? (identity as WorkflowV17DescriptorIdentity).sourceSite
    : (identity as WorkflowV17ProductIdentity | WorkflowV17ReferenceIdentity).authorityId;
  return `${family}:${id}`;
}

function copyFields(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) throw new TypeError("Workflow v17 authority fields must be a plain object");
  const seen = new Set<object>();
  const copy = (current: unknown): unknown => {
    if (current === undefined || current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new TypeError("Workflow v17 authority fields require finite numbers");
      return current;
    }
    if (!current || typeof current !== "object") throw new TypeError(`Unsupported workflow v17 authority field ${typeof current}`);
    if (AUTHORITY_VALUES.has(current)) return current;
    if (seen.has(current)) throw new TypeError("Workflow v17 authority fields may not be cyclic");
    seen.add(current);
    try {
      if (Array.isArray(current)) return Object.freeze(current.map(copy));
      if (!plainRecord(current)) throw new TypeError("Workflow v17 authority fields must contain plain data or authority values");
      const result = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (FORBIDDEN_KEYS.has(key) || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new TypeError(`Workflow v17 authority field ${key} is unavailable`);
        }
        result[key] = copy(descriptor.value);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(current);
    }
  };
  return copy(value) as Readonly<Record<string, unknown>>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
