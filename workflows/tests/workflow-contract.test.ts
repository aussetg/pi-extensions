import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_DESCRIPTOR_IDENTITY_SCHEMA,
  WORKFLOW_DESCRIPTOR_KINDS,
  WORKFLOW_MODULE,
  WORKFLOW_PRODUCT_KINDS,
  WORKFLOW_PRODUCT_IDENTITY_SCHEMA,
  WORKFLOW_REFERENCE_KINDS,
  WORKFLOW_REFERENCE_IDENTITY_SCHEMA,
  WORKFLOW_RESOURCE_KINDS,
  WORKFLOW_RESOURCE_IDENTITY_SCHEMA,
  WORKFLOW_RUNTIME_API_DESCRIPTOR,
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_SOURCE_EXTENSION,
} from "../src/definition/workflow-language.js";

describe("workflow public contract", () => {
  it("pins the exact reviewed language identity", () => {
    expect(WORKFLOW_MODULE).toBe("pi/workflows");
    expect(WORKFLOW_SOURCE_EXTENSION).toBe(".flow.ts");
    expect(WORKFLOW_RUNTIME_API_HASH).toBe(
      "sha256:266734901150f4999a2c07585c1522188ffc2584cc61e65b3008995b07fbcf7c",
    );
  });

  it("freezes descriptor, product, reference, and resource authority variants", () => {
    expect(WORKFLOW_DESCRIPTOR_KINDS).toEqual(["agent-task", "command-task"]);
    expect(WORKFLOW_PRODUCT_KINDS).toEqual([
      "artifact",
      "agent-result",
      "command-result",
      "candidate",
      "accepted-candidate",
      "verification",
      "measurement",
    ]);
    expect(WORKFLOW_REFERENCE_KINDS).toEqual(["launch-snapshot", "candidate-workspace", "metric-set"]);
    expect(WORKFLOW_RESOURCE_KINDS).toEqual(["measurement-profile"]);
    expect(deeplyFrozen(WORKFLOW_RUNTIME_API_DESCRIPTOR)).toBe(true);
  });

  it("pins strict identity schemas for every private authority family", () => {
    const ajv = new Ajv({ strict: true });
    const descriptor = ajv.compile(WORKFLOW_DESCRIPTOR_IDENTITY_SCHEMA);
    const product = ajv.compile(WORKFLOW_PRODUCT_IDENTITY_SCHEMA);
    const reference = ajv.compile(WORKFLOW_REFERENCE_IDENTITY_SCHEMA);
    const resource = ajv.compile(WORKFLOW_RESOURCE_IDENTITY_SCHEMA);
    const hash = `sha256:${"a".repeat(64)}`;

    expect(descriptor({
      kind: "agent-task",
      sourceSite: "descriptor-000001",
      definitionHash: hash,
    })).toBe(true);
    expect(descriptor({
      kind: "inline-task",
      sourceSite: "descriptor-000001",
      definitionHash: hash,
    })).toBe(false);

    expect(product({
      kind: "verification",
      authorityId: "product-000001",
      authorityHash: hash,
    })).toBe(true);
    expect(product({
      kind: "verification",
      authorityId: "product-000001",
      authorityHash: hash,
      forged: true,
    })).toBe(false);

    expect(reference({
      kind: "candidate-workspace",
      authorityId: "workspace-000001",
      authorityHash: hash,
    })).toBe(true);
    expect(reference({
      kind: "candidate",
      authorityId: "workspace-000001",
      authorityHash: hash,
    })).toBe(false);

    expect(resource({
      kind: "measurement-profile",
      selector: "project:parser-benchmark",
      snapshotHash: hash,
    })).toBe(true);
    expect(resource({
      kind: "measurement-profile",
      selector: "./arbitrary-command",
      snapshotHash: hash,
    })).toBe(false);
  });

  it("contains only the native-control-flow operation surface", () => {
    const descriptor = WORKFLOW_RUNTIME_API_DESCRIPTOR as Record<string, unknown>;
    expect(descriptor.structuredOperations).toEqual(["parallel", "map", "candidate"]);
    expect(descriptor.durableOperations).toEqual([
      "agent",
      "command",
      "ask",
      "measure",
      "verify",
      "accept",
      "reject",
      "recordExperiment",
      "apply",
    ]);
    expect(descriptor.synchronousOperations).toEqual(["metrics"]);
  });
});

function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deeplyFrozen);
}
