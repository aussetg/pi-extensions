import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorkflowAgentInputs } from "../src/artifacts/agent-inputs.js";
import {
  workflowArtifactManifest,
} from "../src/artifacts/manifest.js";
import { WorkflowEffectProductFactory } from "../src/artifacts/products.js";
import { WorkflowStructuralValueCodec } from "../src/runtime/structural-values.js";
import {
  WorkflowArtifactStore,
  WorkflowArtifactStoreError,
} from "../src/artifacts/store.js";
import { parseWorkflow } from "../src/definition/workflow-frontend.js";
import type { WorkflowProductIdentity } from "../src/definition/workflow-language.js";
import { createWorkflowInvocationSnapshot } from "../src/persistence/workflow-invocation.js";
import { WorkflowRunDatabase } from "../src/persistence/run-database.js";
import { defaultWorkflowRegistryPolicy } from "../src/registry/workflow-policy.js";
import {
  workflowDefinitionHash,
  type WorkflowDefinitionRef,
} from "../src/registry/structured-workflows.js";
import { WorkflowControlAuthorityRegistry } from "../src/runtime/control-authority.js";
import { evaluateWorkflowControl } from "../src/runtime/control-worker-host.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const closeables = new Set<{ close(): void }>();
const BASE_TIME = Date.parse("2026-07-01T12:00:00.000Z");

const SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Exercise artifact products.",
  input: s.object({}),
  output: s.json(),
  async run(_flow, _args) { return {}; },
});
`;

afterEach(() => {
  for (const value of closeables) value.close();
  closeables.clear();
  for (const root of roots.splice(0)) {
    makeTreeRemovable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workflow artifacts and products", () => {
  it("stores canonical content-addressed artifacts compatible with replay", async () => {
    const fixture = createFixture();
    const first = await fixture.store.putJson({
      kind: "agent-output",
      value: { answer: 42, nested: [true, "yes"] },
    });
    expect(fs.readFileSync(first.bodyPath, "utf8")).toBe('{"answer":42,"nested":[true,"yes"]}');
    expect(first.record).toMatchObject({
      runId: "flow_test_artifacts",
      kind: "agent-output",
      mediaType: "application/json",
      bodyPath: `artifacts/${first.record.digest.slice(7)}/body`,
    });
    expect(fixture.database.readArtifact(first.record.digest)).toEqual(first.record);
    const metadata = fs.readFileSync(path.join(
      fixture.root,
      "artifacts",
      first.record.digest.slice(7),
      "metadata.json",
    ), "utf8");
    expect(JSON.parse(metadata)).toEqual({ ...first.record });

    const duplicate = await fixture.store.putJson({
      kind: "agent-output",
      value: { nested: [true, "yes"], answer: 42 },
    });
    expect(duplicate.record).toEqual(first.record);
    fixture.database.validateIntegrity();
  });

  it("recovers a body and metadata published before SQLite admission", async () => {
    const fixture = createFixture();
    let crashed = false;
    const crashing = new WorkflowArtifactStore(fixture.root, fixture.database, {
      now: clock(),
      faultInjector: point => {
        if (!crashed && point === "after-metadata") {
          crashed = true;
          throw new Error("simulated artifact crash");
        }
      },
    });
    await expect(crashing.putText({ kind: "report", text: "durable" })).rejects.toThrow("simulated artifact crash");
    expect(fixture.database.readArtifact(sha256("durable"))).toBeUndefined();

    const recovered = await fixture.store.putText({ kind: "report", text: "durable" });
    expect(await fixture.store.read(recovered.record)).toEqual(recovered);
    fixture.database.validateIntegrity();
  });

  it("copies binary and file artifacts without following source symlinks", async () => {
    const fixture = createFixture();
    const bytes = await fixture.store.putBytes({
      kind: "binary-evidence",
      bytes: Uint8Array.from([0, 1, 2, 255]),
    });
    expect([...fs.readFileSync(bytes.bodyPath)]).toEqual([0, 1, 2, 255]);

    const source = path.join(fixture.root, "source.bin");
    fs.writeFileSync(source, Buffer.from([9, 8, 7]));
    const copied = await fixture.store.putFile({ kind: "file-evidence", filePath: source });
    expect([...fs.readFileSync(copied.bodyPath)]).toEqual([9, 8, 7]);
    const link = path.join(fixture.root, "source-link.bin");
    fs.symlinkSync(source, link);
    await expect(fixture.store.putFile({ kind: "file-evidence", filePath: link }))
      .rejects.toThrow("source is unsafe");
  });

  it("mints frozen canonical agent products and idempotently restores their authority", async () => {
    const fixture = createFixture();
    const publishedStored = await fixture.store.putText({ kind: "published-evidence", text: "citation" });
    const checkpointStored = await fixture.store.putJson({ kind: "workspace-checkpoint", value: { tree: "abc" } });
    const published = fixture.products.artifact(publishedStored.record);
    const checkpoint = fixture.products.artifact(checkpointStored.record);
    const first = await fixture.products.agentResult({
      authorityId: "agent-result-one",
      output: { answer: "done" },
      published: [published],
      checkpoint,
    });
    const fields = first as {
      output: { answer: string };
      artifact: object;
      published: readonly object[];
      checkpoint: object;
    };
    expect(fields.output).toEqual({ answer: "done" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(fields.output)).toBe(true);
    expect(Object.isFrozen(fields.published)).toBe(true);
    expect(fields.published[0]).toBe(published);
    expect(fields.checkpoint).toBe(checkpoint);
    expect(fixture.products.artifactRecord(fields.artifact)).toMatchObject({ kind: "agent-output" });
    expect(Object.keys(fields.artifact)).toEqual([]);

    const restored = await fixture.products.agentResult({
      authorityId: "agent-result-one",
      output: { answer: "done" },
      published: [published],
      checkpoint,
    });
    expect(restored).toBe(first);
    await expect(fixture.products.agentResult({
      authorityId: "agent-result-one",
      output: { answer: "changed" },
      published: [published],
      checkpoint,
    })).rejects.toThrow("changed identity");
  });

  it("gives command, verification, measurement, and experiment evidence canonical artifacts", async () => {
    const fixture = createFixture();
    const command = await fixture.products.commandResult({
      authorityId: "command-one",
      ok: true,
      exitCode: 0,
      durationMs: 17,
      output: "complete",
      stderrPreview: "warning",
    }) as { artifact: object; output: string };
    expect(command.output).toBe("complete");
    expect(fixture.products.artifactRecord(command.artifact).kind).toBe("command-result");

    const verification = await fixture.products.verification({
      authorityId: "verification-one",
      receiptId: "verification_receipt_one",
      status: "passed",
      evidence: { checks: 4 },
    }) as { passed: boolean; status: string; artifact: object };
    expect(verification).toMatchObject({ passed: true, status: "passed" });
    expect(fixture.products.artifactRecord(verification.artifact).kind).toBe("verification");

    const diagnosticsRecord = await fixture.store.putJson({ kind: "measurement-diagnostics", value: { host: "test" } });
    const diagnostics = fixture.products.artifact(diagnosticsRecord.record);
    const measurement = await fixture.products.measurement({
      authorityId: "measurement-one",
      measurementId: "measurement_one",
      observations: { latency: { value: 12.5, samples: [12, 13] } },
      diagnostics,
    }) as { diagnostics: object; artifact: object; observations: object };
    expect(measurement.diagnostics).toBe(diagnostics);
    expect(measurement.observations).toEqual({ latency: { value: 12.5, samples: [12, 13] } });
    expect(fixture.products.artifactRecord(measurement.artifact).kind).toBe("measurement");

    const experiment = await fixture.products.experimentArtifact({
      experimentId: "experiment_one",
      disposition: "accepted",
      learned: "smaller allocations help",
    });
    expect(fixture.products.artifactRecord(experiment).kind).toBe("experiment");
  });

  it("normalizes nested products and artifacts into one sorted manifest", async () => {
    const fixture = createFixture();
    const finding = await fixture.products.agentResult({
      authorityId: "agent-finding",
      output: { summary: "finding" },
    });
    const draft = await fixture.products.agentResult({
      authorityId: "agent-draft",
      output: { answer: "draft" },
    });
    const draftArtifact = (draft as { artifact: object }).artifact;
    const manifest = workflowArtifactManifest(fixture.products, {
      reports: { draft },
      findings: [finding, draft],
      exact: draftArtifact,
    });
    expect(manifest.entries.map(entry => ({
      path: entry.path,
      productKind: entry.productKind,
      kind: entry.artifact.kind,
    }))).toEqual([
      { path: "exact", productKind: "artifact", kind: "agent-output" },
      { path: "findings/000000", productKind: "agent-result", kind: "agent-output" },
      { path: "findings/000001", productKind: "agent-result", kind: "agent-output" },
      { path: "reports/draft", productKind: "agent-result", kind: "agent-output" },
    ]);
    expect(manifest.entries[0]!.artifact.digest).toBe(manifest.entries[2]!.artifact.digest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
  });

  it("accepts exactly 64 manifest leaves and rejects the 65th", async () => {
    const fixture = createFixture();
    const stored = await fixture.store.putText({ kind: "evidence", text: "bounded" });
    const artifact = fixture.products.artifact(stored.record);
    const allowed = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `item${String(index).padStart(2, "0")}`,
      artifact,
    ]));
    expect(workflowArtifactManifest(fixture.products, allowed).entries).toHaveLength(64);
    expect(() => workflowArtifactManifest(fixture.products, { ...allowed, overflow: artifact }))
      .toThrow("Workflow artifact bundle exceeds 64 leaves");
  });

  it("rejects plain leaves, lookalikes, unsafe segments, cycles, and nonattachable authority", async () => {
    const fixture = createFixture();
    const finding = await fixture.products.agentResult({
      authorityId: "agent-finding",
      output: { summary: "finding" },
    });
    expect(() => workflowArtifactManifest(fixture.products, {
      context: { question: "not an artifact" },
    })).toThrow("artifact input context/question is plain string");
    expect(() => workflowArtifactManifest(fixture.products, {
      fake: { output: { answer: 1 }, artifact: Object.freeze(Object.create(null)) },
    })).toThrow(/artifact input fake\//u);
    expect(() => workflowArtifactManifest(fixture.products, { "../../escape": finding }))
      .toThrow("Invalid workflow artifact segment ../../escape");
    expect(() => workflowArtifactManifest(fixture.products, { safe: { "not a segment": finding } }))
      .toThrow("Invalid workflow artifact segment safe/not a segment");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => workflowArtifactManifest(fixture.products, { cyclic })).toThrow("artifact input cyclic/000000 is cyclic");

    const candidate = fixture.authority.product(productIdentity("candidate", "candidate-one"), {
      output: { ok: true }, changedPaths: [],
    });
    expect(() => workflowArtifactManifest(fixture.products, { candidate }))
      .toThrow("artifact input candidate is not attachable");
    const unbound = fixture.authority.product(productIdentity("agent-result", "agent-unbound"), {
      output: { ok: true }, artifact: (finding as { artifact: object }).artifact, published: [],
    });
    expect(() => workflowArtifactManifest(fixture.products, { unbound }))
      .toThrow("artifact input unbound is not attachable");
    expect(workflowArtifactManifest(fixture.products, {})).toMatchObject({ entries: [] });
    expect(workflowArtifactManifest(fixture.products, { empty: [] })).toMatchObject({ entries: [] });
  });

  it("accepts safe camelCase bundle segments used by ordinary TypeScript", async () => {
    const fixture = createFixture();
    const artifact = fixture.products.artifact((await fixture.store.putText({
      kind: "finding",
      text: "evidence",
    })).record);
    expect(workflowArtifactManifest(fixture.products, {
      experimentPlan: artifact,
      priorWorker: artifact,
    }).entries.map(entry => entry.path)).toEqual(["experimentPlan", "priorWorker"]);
  });

  it("round-trips structured products without confusing plain tag-shaped data", async () => {
    const fixture = createFixture();
    const product = await fixture.products.agentResult({
      authorityId: "agent-structured",
      output: { summary: "finding" },
    });
    const codec = new WorkflowStructuralValueCodec(fixture.authority, fixture.products);
    const plain = {
      kind: "workflow-authority-tree",
      root: { type: "json", value: "ordinary workflow data" },
    };
    const decoded = codec.decode(codec.encode({ plain, product })) as {
      plain: typeof plain;
      product: object;
    };
    expect(decoded.plain).toEqual(plain);
    expect(workflowArtifactManifest(fixture.products, { product: decoded.product }).entries)
      .toEqual([expect.objectContaining({ path: "product", productKind: "agent-result" })]);
  });

  it("materializes nested immutable agent inputs and detects later tampering", async () => {
    const fixture = createFixture();
    const finding = await fixture.products.agentResult({
      authorityId: "agent-finding",
      output: { summary: "finding" },
    });
    const reportRecord = await fixture.store.putText({ kind: "report", text: "report body" });
    const report = fixture.products.artifact(reportRecord.record);
    const manifest = workflowArtifactManifest(fixture.products, {
      findings: [finding],
      reports: { final: report },
    });
    const root = path.join(fixture.root, "inputs", "agent-one");
    const bundle = await materializeWorkflowAgentInputs({ store: fixture.store, root, manifest });
    expect(bundle.entries.map(entry => entry.id)).toEqual(["findings/000000", "reports/final"]);
    expect(JSON.parse(fs.readFileSync(bundle.entries[0]!.path, "utf8"))).toEqual({ summary: "finding" });
    expect(fs.readFileSync(bundle.entries[1]!.path, "utf8")).toBe("report body");
    expect((fs.statSync(root).mode & 0o777)).toBe(0o500);
    expect((fs.statSync(bundle.entries[0]!.path).mode & 0o777)).toBe(0o400);

    const restored = await materializeWorkflowAgentInputs({ store: fixture.store, root, manifest });
    expect(restored).toEqual(bundle);
    fs.chmodSync(bundle.entries[1]!.path, 0o600);
    fs.writeFileSync(bundle.entries[1]!.path, "tampered");
    await expect(materializeWorkflowAgentInputs({ store: fixture.store, root, manifest }))
      .rejects.toThrow("bundle identity collision");
    await expect(materializeWorkflowAgentInputs({
      store: fixture.store,
      root: path.join(fixture.root, "..", "escape"),
      manifest,
    })).rejects.toThrow("escapes its run");
  });

  it("retains product authority across the control wire and materializes it end to end", async () => {
    const fixture = createFixture();
    const workflow = parseWorkflow(`
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ answer: s.string() }) });
      export default workflow({
        description: "Pass one whole product as evidence.", input: s.object({}), output: s.json(),
        async run(flow, _args) {
          const first = await flow.agent(inspect, { prompt: "first" });
          const second = await flow.agent(inspect, { prompt: "second", artifacts: { prior: first } });
          return { answer: second.output.answer, frozen: Object.isFrozen(first.artifact) };
        },
      });
    `, { fileName: "wire-artifacts.flow.ts" });
    const first = await fixture.products.agentResult({
      authorityId: "agent-wire-first",
      output: { answer: "first" },
    });
    const second = await fixture.products.agentResult({
      authorityId: "agent-wire-second",
      output: { answer: "second" },
    });
    let calls = 0;
    const result = await evaluateWorkflowControl({
      workflow,
      flow: {
        agent: async (_site, _task, invocation) => {
          calls++;
          if (calls === 1) return first;
          const prior = (invocation as { artifacts: { prior: object } }).artifacts.prior;
          expect(prior).toBe(first);
          const manifest = workflowArtifactManifest(fixture.products, { prior });
          const bundle = await materializeWorkflowAgentInputs({
            store: fixture.store,
            root: path.join(fixture.root, "inputs", "wire-session"),
            manifest,
          });
          expect(JSON.parse(fs.readFileSync(bundle.entries[0]!.path, "utf8"))).toEqual({ answer: "first" });
          return second;
        },
      },
      args: {},
      authority: fixture.authority,
      signal: new AbortController().signal,
      rootContext: undefined,
      currentContext: () => undefined,
      runInContext: (_context, body) => body(),
    });
    expect(result).toEqual({ answer: "second", frozen: true });
    expect(calls).toBe(2);
  });

  it("fails closed when immutable artifact bodies change", async () => {
    const fixture = createFixture();
    const stored = await fixture.store.putText({ kind: "report", text: "original" });
    fs.chmodSync(stored.bodyPath, 0o600);
    fs.writeFileSync(stored.bodyPath, "modified");
    await expect(fixture.store.read(stored.record)).rejects.toBeInstanceOf(WorkflowArtifactStoreError);
  });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-artifacts-"));
  roots.push(root);
  const parsed = parseWorkflow(SOURCE, { fileName: "artifacts.flow.ts" });
  const policy = defaultWorkflowRegistryPolicy(root, "user");
  const ref: WorkflowDefinitionRef = {
    id: "user:artifacts",
    namespace: "user",
    name: "artifacts",
    description: parsed.metadata.description,
    input: parsed.metadata.input,
    output: parsed.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, "artifacts.flow.ts"),
    source: SOURCE,
    sourceHash: parsed.sourceHash,
    definitionHash: workflowDefinitionHash("user:artifacts", parsed),
    parsed,
  };
  const snapshot = createWorkflowInvocationSnapshot(ref, {}, {
    authority: "user",
    projectTrusted: false,
  });
  const database = track(WorkflowRunDatabase.create(path.join(root, "run.sqlite"), {
    runId: "flow_test_artifacts",
    snapshot,
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    staticResourcesHash: sha256("static-resources"),
    contextIdentityHash: sha256("context"),
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 1024 * 1024 * 1024,
      tasks: 128,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    createdAt: new Date(BASE_TIME).toISOString(),
  }));
  const store = new WorkflowArtifactStore(root, database, { now: clock() });
  const authority = new WorkflowControlAuthorityRegistry("run:artifacts");
  const products = new WorkflowEffectProductFactory(authority, store);
  return { root, database, store, authority, products };
}

function productIdentity(
  kind: WorkflowProductIdentity["kind"],
  authorityId: string,
): WorkflowProductIdentity {
  return { kind, authorityId, authorityHash: stableHash({ kind, authorityId }) };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME + ++tick * 1_000);
}

function track<T extends { close(): void }>(value: T): T {
  closeables.add(value);
  return value;
}

function makeTreeRemovable(root: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeRemovable(path.join(root, name));
  } else fs.chmodSync(root, 0o600);
}
