import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorkflowV17AgentInputs } from "../src/artifacts/agent-inputs-v17.js";
import {
  workflowV17ArtifactManifest,
} from "../src/artifacts/manifest-v17.js";
import { WorkflowV17EffectProductFactory } from "../src/artifacts/products-v17.js";
import { WorkflowV17StructuralValueCodec } from "../src/runtime/structural-values-v17.js";
import {
  WorkflowV17ArtifactStore,
  WorkflowV17ArtifactStoreError,
} from "../src/artifacts/store-v17.js";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import type { WorkflowV17ProductIdentity } from "../src/definition/workflow-language-v17.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import { WorkflowRunDatabaseV17 } from "../src/persistence/run-database-v17.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import { WorkflowV17ControlAuthorityRegistry } from "../src/runtime/control-authority-v17.js";
import { evaluateWorkflowV17Control } from "../src/runtime/control-worker-host-v17.js";
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

describe("workflow v17 artifacts and products", () => {
  it("stores canonical content-addressed artifacts compatible with schema-4 replay", async () => {
    const fixture = createFixture();
    const first = await fixture.store.putJson({
      kind: "agent-output",
      value: { answer: 42, nested: [true, "yes"] },
    });
    expect(fs.readFileSync(first.bodyPath, "utf8")).toBe('{"answer":42,"nested":[true,"yes"]}');
    expect(first.record).toMatchObject({
      runId: "flow_v17_artifacts",
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
    expect(JSON.parse(metadata)).toEqual({ formatVersion: 1, ...first.record });

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
    const crashing = new WorkflowV17ArtifactStore(fixture.root, fixture.database, {
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
    const manifest = workflowV17ArtifactManifest(fixture.products, {
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

  it("rejects plain leaves, lookalikes, unsafe segments, cycles, and nonattachable authority", async () => {
    const fixture = createFixture();
    const finding = await fixture.products.agentResult({
      authorityId: "agent-finding",
      output: { summary: "finding" },
    });
    expect(() => workflowV17ArtifactManifest(fixture.products, {
      context: { question: "not an artifact" },
    })).toThrow("artifact input context/question is plain string");
    expect(() => workflowV17ArtifactManifest(fixture.products, {
      fake: { output: { answer: 1 }, artifact: Object.freeze(Object.create(null)) },
    })).toThrow(/artifact input fake\//u);
    expect(() => workflowV17ArtifactManifest(fixture.products, { "../../escape": finding }))
      .toThrow("Invalid workflow v17 artifact segment ../../escape");
    expect(() => workflowV17ArtifactManifest(fixture.products, { safe: { "not a segment": finding } }))
      .toThrow("Invalid workflow v17 artifact segment safe/not a segment");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => workflowV17ArtifactManifest(fixture.products, { cyclic })).toThrow("artifact input cyclic/000000 is cyclic");

    const candidate = fixture.authority.product(productIdentity("candidate", "candidate-one"), {
      output: { ok: true }, changedPaths: [],
    });
    expect(() => workflowV17ArtifactManifest(fixture.products, { candidate }))
      .toThrow("artifact input candidate is not attachable");
    const unbound = fixture.authority.product(productIdentity("agent-result", "agent-unbound"), {
      output: { ok: true }, artifact: (finding as { artifact: object }).artifact, published: [],
    });
    expect(() => workflowV17ArtifactManifest(fixture.products, { unbound }))
      .toThrow("artifact input unbound is not attachable");
    expect(workflowV17ArtifactManifest(fixture.products, {})).toMatchObject({ entries: [] });
    expect(workflowV17ArtifactManifest(fixture.products, { empty: [] })).toMatchObject({ entries: [] });
  });

  it("accepts safe camelCase bundle segments used by ordinary TypeScript", async () => {
    const fixture = createFixture();
    const artifact = fixture.products.artifact((await fixture.store.putText({
      kind: "finding",
      text: "evidence",
    })).record);
    expect(workflowV17ArtifactManifest(fixture.products, {
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
    const codec = new WorkflowV17StructuralValueCodec(fixture.authority, fixture.products);
    const plain = {
      formatVersion: 1,
      kind: "workflow-v17-authority-tree",
      root: { type: "json", value: "ordinary workflow data" },
    };
    const decoded = codec.decode(codec.encode({ plain, product })) as {
      plain: typeof plain;
      product: object;
    };
    expect(decoded.plain).toEqual(plain);
    expect(workflowV17ArtifactManifest(fixture.products, { product: decoded.product }).entries)
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
    const manifest = workflowV17ArtifactManifest(fixture.products, {
      findings: [finding],
      reports: { final: report },
    });
    const root = path.join(fixture.root, "inputs", "agent-one");
    const bundle = await materializeWorkflowV17AgentInputs({ store: fixture.store, root, manifest });
    expect(bundle.entries.map(entry => entry.id)).toEqual(["findings/000000", "reports/final"]);
    expect(JSON.parse(fs.readFileSync(bundle.entries[0]!.path, "utf8"))).toEqual({ summary: "finding" });
    expect(fs.readFileSync(bundle.entries[1]!.path, "utf8")).toBe("report body");
    expect((fs.statSync(root).mode & 0o777)).toBe(0o500);
    expect((fs.statSync(bundle.entries[0]!.path).mode & 0o777)).toBe(0o400);

    const restored = await materializeWorkflowV17AgentInputs({ store: fixture.store, root, manifest });
    expect(restored).toEqual(bundle);
    fs.chmodSync(bundle.entries[1]!.path, 0o600);
    fs.writeFileSync(bundle.entries[1]!.path, "tampered");
    await expect(materializeWorkflowV17AgentInputs({ store: fixture.store, root, manifest }))
      .rejects.toThrow("bundle identity collision");
    await expect(materializeWorkflowV17AgentInputs({
      store: fixture.store,
      root: path.join(fixture.root, "..", "escape"),
      manifest,
    })).rejects.toThrow("escapes its run");
  });

  it("retains product authority across the control wire and materializes it end to end", async () => {
    const fixture = createFixture();
    const workflow = parseWorkflowV17(`
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
    const result = await evaluateWorkflowV17Control({
      workflow,
      flow: {
        agent: async (_site, _task, invocation) => {
          calls++;
          if (calls === 1) return first;
          const prior = (invocation as { artifacts: { prior: object } }).artifacts.prior;
          expect(prior).toBe(first);
          const manifest = workflowV17ArtifactManifest(fixture.products, { prior });
          const bundle = await materializeWorkflowV17AgentInputs({
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
    await expect(fixture.store.read(stored.record)).rejects.toBeInstanceOf(WorkflowV17ArtifactStoreError);
  });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v17-artifacts-"));
  roots.push(root);
  const parsed = parseWorkflowV17(SOURCE, { fileName: "artifacts.flow.ts" });
  const policy = defaultWorkflowV17RegistryPolicy(root, "user");
  const ref: WorkflowV17DefinitionRef = {
    formatVersion: 1,
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
    definitionHash: workflowV17DefinitionHash("user:artifacts", parsed),
    parsed,
  };
  const snapshot = createWorkflowV17InvocationSnapshot(ref, {}, {
    authority: "user",
    projectTrusted: false,
  });
  const database = track(WorkflowRunDatabaseV17.create(path.join(root, "run.sqlite"), {
    runId: "flow_v17_artifacts",
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
  const store = new WorkflowV17ArtifactStore(root, database, { now: clock() });
  const authority = new WorkflowV17ControlAuthorityRegistry("run:artifacts");
  const products = new WorkflowV17EffectProductFactory(authority, store);
  return { root, database, store, authority, products };
}

function productIdentity(
  kind: WorkflowV17ProductIdentity["kind"],
  authorityId: string,
): WorkflowV17ProductIdentity {
  return { formatVersion: 1, kind, authorityId, authorityHash: stableHash({ kind, authorityId }) };
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
