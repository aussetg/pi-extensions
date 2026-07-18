import type {
  WorkflowDescriptorIdentity,
  WorkflowProductIdentity,
  WorkflowReferenceIdentity,
} from "../definition/workflow-language.js";
import {
  WORKFLOW_DESCRIPTOR_KINDS,
  WORKFLOW_PRODUCT_KINDS,
  WORKFLOW_REFERENCE_KINDS,
} from "../definition/workflow-language.js";
import type { WorkflowDescriptor } from "../definition/workflow-types.js";
import { stableHash } from "../utils/hashes.js";

export type WorkflowControlAuthorityFamily = "descriptor" | "product" | "reference";

export interface WorkflowControlAuthorityDescription {
  family: WorkflowControlAuthorityFamily;
  identity: WorkflowDescriptorIdentity | WorkflowProductIdentity | WorkflowReferenceIdentity;
  fields: Readonly<Record<string, unknown>>;
  privateAuthority?: unknown;
}

interface AuthorityRecord extends WorkflowControlAuthorityDescription {
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
export class WorkflowControlAuthorityRegistry {
  readonly scopeId: string;
  readonly #owner = Object.freeze(Object.create(null) as object);
  readonly #records = new Map<string, AuthorityRecord>();

  constructor(scopeId: string) {
    if (typeof scopeId !== "string" || scopeId.length < 1 || scopeId.length > 256 || /[\u0000-\u001f\u007f]/u.test(scopeId)) {
      throw new TypeError("Workflow authority scope id is invalid");
    }
    this.scopeId = scopeId;
  }

  descriptor(descriptor: WorkflowDescriptor): object {
    assertDescriptorIdentity(descriptor.identity);
    if (descriptor.kind !== descriptor.identity.kind) {
      throw new TypeError("Workflow descriptor kind differs from its authority identity");
    }
    const key = authorityKey("descriptor", descriptor.identity);
    const existing = this.#records.get(key);
    if (existing) {
      if (!existing.active || stableHash(existing.privateAuthority) !== stableHash(descriptor)) {
        throw new TypeError(`Workflow descriptor authority ${descriptor.identity.sourceSite} changed`);
      }
      return existing.value;
    }
    return this.#create("descriptor", descriptor.identity, {}, descriptor);
  }

  product(
    identity: WorkflowProductIdentity,
    fields: Readonly<Record<string, unknown>> = {},
    privateAuthority?: unknown,
  ): object {
    assertProductIdentity(identity);
    return this.#create("product", identity, fields, privateAuthority);
  }

  reference(
    identity: WorkflowReferenceIdentity,
    fields: Readonly<Record<string, unknown>> = {},
    privateAuthority?: unknown,
  ): object {
    assertReferenceIdentity(identity);
    return this.#create("reference", identity, fields, privateAuthority);
  }

  describe(value: unknown): WorkflowControlAuthorityDescription | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = AUTHORITY_VALUES.get(value);
    if (!record) return undefined;
    this.#assertOwned(record);
    return description(record);
  }

  /** Used by the wire encoder so foreign and revoked authority fails closed. */
  transport(value: object): WorkflowControlAuthorityDescription | undefined {
    const record = AUTHORITY_VALUES.get(value);
    if (!record) return undefined;
    this.#assertOwned(record);
    return description(record);
  }

  revoke(value: unknown): void {
    if (!value || typeof value !== "object") throw new TypeError("Workflow authority value is invalid");
    const record = AUTHORITY_VALUES.get(value);
    if (!record) throw new TypeError("Workflow value has no authority");
    this.#assertOwned(record);
    record.active = false;
  }

  #create(
    family: WorkflowControlAuthorityFamily,
    identity: WorkflowControlAuthorityDescription["identity"],
    fieldsValue: Readonly<Record<string, unknown>>,
    privateAuthority?: unknown,
  ): object {
    const key = authorityKey(family, identity);
    if (this.#records.has(key)) throw new TypeError(`Duplicate workflow ${family} authority ${key}`);
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
      throw new WorkflowAuthorityScopeError(
        `Workflow authority belongs to another scope, not ${this.scopeId}`,
      );
    }
    if (!record.active) throw new WorkflowStaleAuthorityError("Workflow authority has been revoked");
  }
}

export class WorkflowAuthorityScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowAuthorityScopeError";
  }
}

export class WorkflowStaleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStaleAuthorityError";
  }
}

export function isWorkflowControlAuthority(value: unknown): value is object {
  return Boolean(value) && typeof value === "object" && AUTHORITY_VALUES.has(value as object);
}

export function assertDescriptorIdentity(value: WorkflowDescriptorIdentity): void {
  if (!plainRecord(value) || !WORKFLOW_DESCRIPTOR_KINDS.includes(value.kind as never)
    || typeof value.sourceSite !== "string" || !SOURCE_SITE.test(value.sourceSite)
    || typeof value.definitionHash !== "string" || !HASH.test(value.definitionHash)
    || !exactKeys(value, ["kind", "sourceSite", "definitionHash"])) {
    throw new TypeError("Workflow descriptor identity is invalid");
  }
}

export function assertProductIdentity(value: WorkflowProductIdentity): void {
  if (!plainRecord(value) || !WORKFLOW_PRODUCT_KINDS.includes(value.kind as never)
    || typeof value.authorityId !== "string" || !AUTHORITY_ID.test(value.authorityId)
    || typeof value.authorityHash !== "string" || !HASH.test(value.authorityHash)
    || !exactKeys(value, ["kind", "authorityId", "authorityHash"])) {
    throw new TypeError("Workflow product identity is invalid");
  }
}

export function assertReferenceIdentity(value: WorkflowReferenceIdentity): void {
  if (!plainRecord(value) || !WORKFLOW_REFERENCE_KINDS.includes(value.kind as never)
    || typeof value.authorityId !== "string" || !AUTHORITY_ID.test(value.authorityId)
    || typeof value.authorityHash !== "string" || !HASH.test(value.authorityHash)
    || !exactKeys(value, ["kind", "authorityId", "authorityHash"])) {
    throw new TypeError("Workflow reference identity is invalid");
  }
}

function description(record: AuthorityRecord): WorkflowControlAuthorityDescription {
  return {
    family: record.family,
    identity: structuredClone(record.identity),
    fields: record.fields,
    ...(record.privateAuthority !== undefined ? { privateAuthority: record.privateAuthority } : {}),
  };
}

function authorityKey(
  family: WorkflowControlAuthorityFamily,
  identity: WorkflowControlAuthorityDescription["identity"],
): string {
  const id = family === "descriptor"
    ? (identity as WorkflowDescriptorIdentity).sourceSite
    : (identity as WorkflowProductIdentity | WorkflowReferenceIdentity).authorityId;
  return `${family}:${id}`;
}

function copyFields(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) throw new TypeError("Workflow authority fields must be a plain object");
  const seen = new Set<object>();
  const copy = (current: unknown): unknown => {
    if (current === undefined || current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new TypeError("Workflow authority fields require finite numbers");
      return current;
    }
    if (!current || typeof current !== "object") throw new TypeError(`Unsupported workflow authority field ${typeof current}`);
    if (AUTHORITY_VALUES.has(current)) return current;
    if (seen.has(current)) throw new TypeError("Workflow authority fields may not be cyclic");
    seen.add(current);
    try {
      if (Array.isArray(current)) return Object.freeze(current.map(copy));
      if (!plainRecord(current)) throw new TypeError("Workflow authority fields must contain plain data or authority values");
      const result = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (FORBIDDEN_KEYS.has(key) || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new TypeError(`Workflow authority field ${key} is unavailable`);
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
