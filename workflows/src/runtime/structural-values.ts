import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowProductIdentity } from "../definition/workflow-language.js";
import type { JsonValue } from "../types.js";
import { WorkflowEffectProductFactory } from "../artifacts/products.js";
import { WorkflowControlAuthorityRegistry } from "./control-authority.js";

const FORMAT = "workflow-authority-tree";

type EncodedNode =
  | { type: "json"; value: null | boolean | number | string }
  | { type: "array"; values: EncodedNode[] }
  | { type: "object"; entries: Array<[string, EncodedNode]> }
  | { type: "artifact"; digest: string }
  | {
      type: "product";
      identity: WorkflowProductIdentity;
      fields: Array<[string, EncodedNode]>;
    };

interface EncodedTree {
  formatVersion: 1;
  kind: typeof FORMAT;
  root: EncodedNode;
}

/** Persist plain structural data while retaining explicit product/artifact authority. */
export class WorkflowStructuralValueCodec {
  constructor(
    private readonly authority: WorkflowControlAuthorityRegistry,
    private readonly products: WorkflowEffectProductFactory,
  ) {
    if (products.authority !== authority) {
      throw new TypeError("Workflow v17 structural value authority differs from its product factory");
    }
  }

  encode(value: unknown): JsonValue {
    const state = { nodes: 0, ancestors: new Set<object>() };
    const root = this.encodeNode(value, 0, state);
    return { formatVersion: 1, kind: FORMAT, root } as unknown as JsonValue;
  }

  decode(value: JsonValue): unknown {
    if (!isTree(value)) return structuredClone(value);
    const state = { nodes: 0 };
    return this.decodeNode(value.root, 0, state);
  }

  private encodeNode(
    value: unknown,
    depth: number,
    state: { nodes: number; ancestors: Set<object> },
  ): EncodedNode {
    this.consume(depth, ++state.nodes);
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return { type: "json", value };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError("Workflow v17 structural values require finite JSON numbers");
      }
      return { type: "json", value };
    }
    if (!value || typeof value !== "object") {
      throw new TypeError(`Workflow v17 structural value contains unsupported ${typeof value}`);
    }
    const description = this.authority.describe(value);
    if (description) {
      if (description.family !== "product") {
        throw new TypeError(`Workflow v17 structural values cannot retain ${description.family} authority`);
      }
      const identity = description.identity as WorkflowProductIdentity;
      if (identity.kind === "artifact") {
        return { type: "artifact", digest: this.products.artifactRecord(value).digest };
      }
      // Candidate authority is deliberately unavailable in read-only structured lanes.
      this.products.attachableArtifact(value);
      return {
        type: "product",
        identity: structuredClone(identity),
        fields: Object.keys(description.fields).sort().map(key => [
          key,
          this.encodeNode(description.fields[key], depth + 1, state),
        ]),
      };
    }
    if (state.ancestors.has(value)) throw new TypeError("Workflow v17 structural values may not be cyclic");
    state.ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return { type: "array", values: value.map(entry => this.encodeNode(entry, depth + 1, state)) };
      }
      if (!plainRecord(value)) throw new TypeError("Workflow v17 structural values must be plain data or products");
      const entries: Array<[string, EncodedNode]> = [];
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new TypeError(`Workflow v17 structural property ${key} is unavailable`);
        }
        entries.push([key, this.encodeNode(descriptor.value, depth + 1, state)]);
      }
      return { type: "object", entries };
    } finally {
      state.ancestors.delete(value);
    }
  }

  private decodeNode(node: EncodedNode, depth: number, state: { nodes: number }): unknown {
    this.consume(depth, ++state.nodes);
    if (node.type === "json") return node.value;
    if (node.type === "artifact") {
      const record = this.products.store.database.readArtifact(node.digest);
      if (!record) throw new Error(`Workflow v17 structural artifact ${node.digest} is unavailable`);
      return this.products.artifact(record);
    }
    if (node.type === "array") return node.values.map(value => this.decodeNode(value, depth + 1, state));
    if (node.type === "object") {
      return Object.fromEntries(node.entries.map(([key, value]) => [
        key,
        this.decodeNode(value, depth + 1, state),
      ]));
    }
    const fields = Object.fromEntries(node.fields.map(([key, value]) => [
      key,
      this.decodeNode(value, depth + 1, state),
    ]));
    return this.products.restoreAttachableProduct(node.identity, fields);
  }

  private consume(depth: number, nodes: number): void {
    if (depth > DEFINITION_LIMITS.structuralValueDepth
      || nodes > DEFINITION_LIMITS.structuralValueNodes) {
      throw new TypeError("Workflow v17 structural value exceeds its structural limit");
    }
  }
}

function isTree(value: JsonValue): value is JsonValue & EncodedTree {
  if (!plainRecord(value) || value.formatVersion !== 1 || value.kind !== FORMAT) return false;
  validateNode(value.root, 0, { nodes: 0 });
  return true;
}

function validateNode(value: unknown, depth: number, state: { nodes: number }): asserts value is EncodedNode {
  if (++state.nodes > DEFINITION_LIMITS.structuralValueNodes
    || depth > DEFINITION_LIMITS.structuralValueDepth || !plainRecord(value)) {
    throw new TypeError("Workflow v17 encoded structural value is invalid");
  }
  if (value.type === "json") {
    if (!exactKeys(value, ["type", "value"]) || (value.value !== null
      && typeof value.value !== "boolean" && typeof value.value !== "string"
      && (typeof value.value !== "number" || !Number.isFinite(value.value) || Object.is(value.value, -0)))) {
      throw new TypeError("Workflow v17 encoded structural primitive is invalid");
    }
    return;
  }
  if (value.type === "artifact") {
    if (!exactKeys(value, ["type", "digest"])
      || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) {
      throw new TypeError("Workflow v17 encoded structural artifact is invalid");
    }
    return;
  }
  if (value.type === "array") {
    if (!exactKeys(value, ["type", "values"]) || !Array.isArray(value.values)) {
      throw new TypeError("Workflow v17 encoded structural array is invalid");
    }
    for (const entry of value.values) validateNode(entry, depth + 1, state);
    return;
  }
  if (value.type === "object") {
    if (!exactKeys(value, ["type", "entries"])) throw new TypeError("Workflow v17 encoded structural object is invalid");
    validateEntries(value.entries, depth, state);
    return;
  }
  if (value.type === "product") {
    if (!exactKeys(value, ["type", "identity", "fields"]) || !plainRecord(value.identity)
      || value.identity.formatVersion !== 1 || typeof value.identity.kind !== "string"
      || typeof value.identity.authorityId !== "string" || typeof value.identity.authorityHash !== "string") {
      throw new TypeError("Workflow v17 encoded structural product is invalid");
    }
    validateEntries(value.fields, depth, state);
    return;
  }
  throw new TypeError("Workflow v17 encoded structural node kind is invalid");
}

function validateEntries(value: unknown, depth: number, state: { nodes: number }): void {
  if (!Array.isArray(value)) throw new TypeError("Workflow v17 encoded structural entries are invalid");
  let previous = "";
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0] <= previous) {
      throw new TypeError("Workflow v17 encoded structural entry order is invalid");
    }
    previous = entry[0];
    validateNode(entry[1], depth + 1, state);
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
