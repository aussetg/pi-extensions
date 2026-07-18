// Executable oracle for the workflow runtime conformance contract.
import crypto from "node:crypto";

export class MeasurementRegistry {
  constructor(profiles = []) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, freezeProfile(profile)]));
  }

  resolve(selector, { projectTrusted = false } = {}) {
    const profile = this.profiles.get(selector);
    if (!profile) throw new Error(`unknown measurement profile ${selector}`);
    if (selector.startsWith("project:") && !projectTrusted) {
      throw new Error(`project measurement profile ${selector} requires project trust`);
    }
    return structuredClone(profile);
  }

  toolSchema({ projectTrusted = false } = {}) {
    const ids = [...this.profiles.keys()]
      .filter((id) => projectTrusted || !id.startsWith("project:"))
      .sort();
    return { type: "string", enum: ids, "x-flow-resource": "measurement-profile" };
  }
}

export function prepareOptimizeInvocation(raw, registry, options = {}) {
  const profile = registry.resolve(raw.evaluator, options);
  const policies = [
    raw.metrics.primary,
    ...(raw.metrics.guardrails ?? []),
    ...(raw.metrics.observe ?? []),
  ];
  const outputs = new Set();
  for (const policy of policies) {
    if (!Object.hasOwn(profile.outputs, policy.output)) {
      throw new Error(`measurement profile ${profile.id} has no output ${policy.output}`);
    }
    if (outputs.has(policy.output)) throw new Error(`duplicate optimization output ${policy.output}`);
    outputs.add(policy.output);
  }
  const snapshot = Object.freeze({
    kind: "measurement-profile",
    selector: raw.evaluator,
    profile,
    hash: hash(profile),
  });
  return {
    input: structuredClone(raw),
    resources: new InvocationResources([snapshot]),
    snapshot,
  };
}

export class InvocationResources {
  #measurements;

  constructor(resources) {
    this.#measurements = new Map(resources.map((resource) => [resource.selector, resource]));
  }

  measurement(selector) {
    const resource = this.#measurements.get(selector);
    if (!resource) throw new Error(`measurement profile ${selector} is not pinned by this invocation`);
    return structuredClone(resource);
  }
}

export function measurementSemanticKey(resource, policy) {
  return hash({
    format: 1,
    profileHash: resource.hash,
    policy,
  });
}

function freezeProfile(profile) {
  const copy = structuredClone(profile);
  copy.hash = hash(copy);
  return deepFreeze(copy);
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(stable(value)).digest("hex")}`;
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
