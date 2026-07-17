import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_V17_DESCRIPTOR_IDENTITY_SCHEMA,
  WORKFLOW_V17_DESCRIPTOR_KINDS,
  WORKFLOW_V17_MODULE,
  WORKFLOW_V17_PRODUCT_KINDS,
  WORKFLOW_V17_PRODUCT_IDENTITY_SCHEMA,
  WORKFLOW_V17_REFERENCE_KINDS,
  WORKFLOW_V17_REFERENCE_IDENTITY_SCHEMA,
  WORKFLOW_V17_RESOURCE_KINDS,
  WORKFLOW_V17_RESOURCE_IDENTITY_SCHEMA,
  WORKFLOW_V17_RUNTIME_API_DESCRIPTOR,
  WORKFLOW_V17_RUNTIME_API_HASH,
  WORKFLOW_V17_RUNTIME_API_VERSION,
  WORKFLOW_V17_SOURCE_EXTENSION,
} from "../src/definition/workflow-language-v17.js";

describe("workflow v17 public contract", () => {
  it("pins the exact reviewed language identity", () => {
    expect(WORKFLOW_V17_RUNTIME_API_VERSION).toBe(17);
    expect(WORKFLOW_V17_MODULE).toBe("pi/workflows");
    expect(WORKFLOW_V17_SOURCE_EXTENSION).toBe(".flow.ts");
    expect(WORKFLOW_V17_RUNTIME_API_HASH).toBe(
      "sha256:3ea83475c353de4c9479b0f27664cabd3aa6413e956c27ce0ad9a39ce91cd612",
    );
  });

  it("freezes descriptor, product, reference, and resource authority variants", () => {
    expect(WORKFLOW_V17_DESCRIPTOR_KINDS).toEqual(["agent-task", "command-task"]);
    expect(WORKFLOW_V17_PRODUCT_KINDS).toEqual([
      "artifact",
      "agent-result",
      "command-result",
      "candidate",
      "accepted-candidate",
      "verification",
      "measurement",
    ]);
    expect(WORKFLOW_V17_REFERENCE_KINDS).toEqual(["launch-snapshot", "candidate-workspace", "metric-set"]);
    expect(WORKFLOW_V17_RESOURCE_KINDS).toEqual(["measurement-profile"]);
    expect(deeplyFrozen(WORKFLOW_V17_RUNTIME_API_DESCRIPTOR)).toBe(true);
  });

  it("pins strict identity schemas for every private authority family", () => {
    const ajv = new Ajv({ strict: true });
    const descriptor = ajv.compile(WORKFLOW_V17_DESCRIPTOR_IDENTITY_SCHEMA);
    const product = ajv.compile(WORKFLOW_V17_PRODUCT_IDENTITY_SCHEMA);
    const reference = ajv.compile(WORKFLOW_V17_REFERENCE_IDENTITY_SCHEMA);
    const resource = ajv.compile(WORKFLOW_V17_RESOURCE_IDENTITY_SCHEMA);
    const hash = `sha256:${"a".repeat(64)}`;

    expect(descriptor({
      formatVersion: 1,
      kind: "agent-task",
      sourceSite: "descriptor-000001",
      definitionHash: hash,
    })).toBe(true);
    expect(descriptor({
      formatVersion: 1,
      kind: "inline-task",
      sourceSite: "descriptor-000001",
      definitionHash: hash,
    })).toBe(false);

    expect(product({
      formatVersion: 1,
      kind: "verification",
      authorityId: "product-000001",
      authorityHash: hash,
    })).toBe(true);
    expect(product({
      formatVersion: 1,
      kind: "verification",
      authorityId: "product-000001",
      authorityHash: hash,
      forged: true,
    })).toBe(false);

    expect(reference({
      formatVersion: 1,
      kind: "candidate-workspace",
      authorityId: "workspace-000001",
      authorityHash: hash,
    })).toBe(true);
    expect(reference({
      formatVersion: 1,
      kind: "candidate",
      authorityId: "workspace-000001",
      authorityHash: hash,
    })).toBe(false);

    expect(resource({
      formatVersion: 1,
      kind: "measurement-profile",
      selector: "project:parser-benchmark",
      snapshotHash: hash,
    })).toBe(true);
    expect(resource({
      formatVersion: 1,
      kind: "measurement-profile",
      selector: "./arbitrary-command",
      snapshotHash: hash,
    })).toBe(false);
  });

  it("contains only the native-control-flow operation surface", () => {
    const descriptor = WORKFLOW_V17_RUNTIME_API_DESCRIPTOR as Record<string, unknown>;
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
    expect(descriptor.removedOperations).toEqual(["stage", "loop", "fanOut", "checkpoint", "metric"]);
    expect(descriptor.removedAuthorFields).toEqual([
      "name",
      "inputSchema",
      "outputSchema",
      "capabilities",
      "modelVisible",
      "maxParallelism",
    ]);
  });
});

function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deeplyFrozen);
}
