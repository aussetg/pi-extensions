// Executable oracle for the workflow runtime v17 conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactAuthority, ProductRealm } from "./model.js";

const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const authority = new ArtifactAuthority();
  const host = new ProductRealm(authority);
  const control = new ProductRealm(authority);
  const findingRef = host.artifact(authority.issue(digest("a"), "agent-output"));
  const draftRef = host.artifact(authority.issue(digest("b"), "agent-output"));
  const finding = host.product("agent", { summary: "finding" }, findingRef);
  const draft = host.product("agent", { answer: "draft" }, draftRef);
  return { authority, host, control, findingRef, draftRef, finding, draft };
}

test("whole effect products retain a nonforgeable brand through wire round trips", () => {
  const { host, control, finding } = fixture();
  const remote = control.decode(host.encode(finding));
  assert.equal(remote.output.summary, "finding");
  assert.equal(control.productRecord(remote).kind, "agent");
  const returned = host.decode(control.encode(remote));
  assert.equal(host.productRecord(returned).artifact.digest, digest("a"));
});

test("named arrays and records produce one canonical sorted manifest", () => {
  const { host, finding, draft } = fixture();
  assert.deepEqual(host.manifest({
    reports: { draft },
    findings: [finding, draft],
  }), [
    { path: "findings/000000", digest: digest("a"), kind: "agent-output" },
    { path: "findings/000001", digest: digest("b"), kind: "agent-output" },
    { path: "reports/draft", digest: digest("b"), kind: "agent-output" },
  ]);
});

test("repeated artifact authority is explicit and preserved at each manifest path", () => {
  const { host, draftRef } = fixture();
  assert.deepEqual(host.manifest({ left: draftRef, right: draftRef }).map((entry) => entry.path), ["left", "right"]);
});

test("plain JSON leaves are rejected with their exact path", () => {
  const { host } = fixture();
  assert.throws(
    () => host.manifest({ context: { question: "not an artifact" } }),
    /artifact input context\/question is plain string/,
  );
});

test("a lookalike product cannot mint artifact authority", () => {
  const { host } = fixture();
  const fake = { output: { answer: 1 }, artifact: Object.freeze(Object.create(null)) };
  assert.equal(host.productRecord(fake), undefined);
  assert.throws(() => host.manifest({ fake }), /artifact input fake\//);
});

test("a plain container may deliberately contain a real artifact leaf", () => {
  const { host, findingRef } = fixture();
  assert.deepEqual(host.manifest({ evidence: { exact: findingRef } }), [
    { path: "evidence/exact", digest: digest("a"), kind: "agent-output" },
  ]);
});

test("unsafe dynamic names are rejected rather than sanitized ambiguously", () => {
  const { host, finding } = fixture();
  assert.throws(() => host.manifest({ "../../escape": finding }), /invalid artifact segment/);
  assert.throws(() => host.manifest({ safe: { "not a segment": finding } }), /invalid artifact segment/);
});

test("empty containers have a deterministic empty manifest", () => {
  const { host } = fixture();
  assert.deepEqual(host.manifest({}), []);
  assert.deepEqual(host.manifest({ empty: [] }), []);
});
