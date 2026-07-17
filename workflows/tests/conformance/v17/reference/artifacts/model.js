// Executable oracle for the workflow runtime v17 conformance contract.
const SEGMENT = /^[a-z][a-z0-9_-]{0,63}$/;

/** Shared host authority. Neither realm can mint refs without this registry. */
export class ArtifactAuthority {
  #records = new Map();

  issue(id, kind = "agent-output") {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new TypeError("invalid artifact digest");
    const record = Object.freeze({ digest: id, kind });
    this.#records.set(id, record);
    return record;
  }

  require(id) {
    const record = this.#records.get(id);
    if (!record) throw new TypeError(`unknown artifact authority ${String(id)}`);
    return record;
  }
}

/**
 * Minimal control-wire probe. Products and artifacts are branded in WeakMaps,
 * and the brand is reconstructed explicitly by the wire protocol.
 */
export class ProductRealm {
  #artifacts = new WeakMap();
  #products = new WeakMap();

  constructor(authority) {
    this.authority = authority;
  }

  artifact(record) {
    const checked = this.authority.require(record.digest);
    const value = Object.freeze(Object.create(null));
    this.#artifacts.set(value, checked);
    return value;
  }

  product(kind, output, artifact, extras = {}) {
    const record = this.artifactRecord(artifact);
    const value = Object.freeze({ output: structuredClone(output), artifact, ...extras });
    this.#products.set(value, Object.freeze({ kind, artifact: record }));
    return value;
  }

  artifactRecord(value) {
    if (!value || typeof value !== "object") throw new TypeError("expected artifact reference");
    const record = this.#artifacts.get(value);
    if (!record) throw new TypeError("value has no artifact authority");
    return record;
  }

  productRecord(value) {
    if (!value || typeof value !== "object") return undefined;
    return this.#products.get(value);
  }

  encode(value) {
    const visit = (current) => {
      if (current === null || ["boolean", "number", "string"].includes(typeof current)) {
        return { type: "json", value: current };
      }
      if (!current || typeof current !== "object") throw new TypeError(`unsupported wire value ${typeof current}`);
      const artifact = this.#artifacts.get(current);
      if (artifact) return { type: "artifact", digest: artifact.digest };
      const product = this.#products.get(current);
      if (product) {
        const entries = Object.keys(current)
          .filter((key) => key !== "artifact")
          .sort()
          .map((key) => [key, visit(current[key])]);
        return {
          type: "product",
          kind: product.kind,
          artifact: { type: "artifact", digest: product.artifact.digest },
          entries,
        };
      }
      if (Array.isArray(current)) return { type: "array", values: current.map(visit) };
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        throw new TypeError("wire objects must be plain or branded");
      }
      return {
        type: "object",
        entries: Object.keys(current).sort().map((key) => [key, visit(current[key])]),
      };
    };
    return visit(value);
  }

  decode(wire) {
    const visit = (current) => {
      if (current.type === "json") return current.value;
      if (current.type === "artifact") return this.artifact(this.authority.require(current.digest));
      if (current.type === "array") return current.values.map(visit);
      if (current.type === "object") return Object.fromEntries(current.entries.map(([key, value]) => [key, visit(value)]));
      if (current.type === "product") {
        const entries = Object.fromEntries(current.entries.map(([key, value]) => [key, visit(value)]));
        const artifact = visit(current.artifact);
        const output = entries.output;
        delete entries.output;
        return this.product(current.kind, output, artifact, entries);
      }
      throw new TypeError(`unknown wire type ${String(current?.type)}`);
    };
    return visit(wire);
  }

  manifest(bundle) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      throw new TypeError("artifact bundle must be a named object");
    }
    const entries = [];
    const visit = (value, path) => {
      const artifact = value && typeof value === "object" ? this.#artifacts.get(value) : undefined;
      if (artifact) {
        entries.push({ path, digest: artifact.digest, kind: artifact.kind });
        return;
      }
      const product = value && typeof value === "object" ? this.#products.get(value) : undefined;
      if (product) {
        entries.push({ path, digest: product.artifact.digest, kind: product.artifact.kind });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}/${String(index).padStart(6, "0")}`));
        return;
      }
      if (value && typeof value === "object") {
        for (const key of Object.keys(value).sort()) {
          if (!SEGMENT.test(key)) throw new TypeError(`invalid artifact segment ${path}/${key}`);
          visit(value[key], `${path}/${key}`);
        }
        return;
      }
      throw new TypeError(`artifact input ${path} is plain ${value === null ? "null" : typeof value}`);
    };
    for (const key of Object.keys(bundle).sort()) {
      if (!SEGMENT.test(key)) throw new TypeError(`invalid artifact segment ${key}`);
      visit(bundle[key], key);
    }
    return Object.freeze(entries.map(Object.freeze));
  }
}
