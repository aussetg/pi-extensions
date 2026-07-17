// Executable oracle for the workflow runtime v17 conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import { CandidateLifecycle, WorkspaceLaneOwnership } from "./model.js";

const passed = { passed: true, binding: "verify:a" };

test("verified nonempty candidate accepts and applies exactly once", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  candidate.accept({ verification: passed });
  candidate.apply({ approved: true, currentVerificationBinding: "verify:a" });
  candidate.apply({ approved: true, currentVerificationBinding: "verify:a" });
  candidate.successfulWorkflowCompletion();
  assert.equal(candidate.state, "applied");
  assert.equal(candidate.events.filter((event) => event.type === "applied").length, 1);
});

test("accepted candidate carries verification so apply does not receive another receipt", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  candidate.accept({ verification: passed });
  assert.throws(
    () => candidate.apply({ approved: true, currentVerificationBinding: "verify:new" }),
    /verification is stale/,
  );
  assert.equal(candidate.state, "accepted");
});

test("human-declined apply leaves an auditable accepted but unapplied candidate", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  candidate.accept({ verification: passed });
  candidate.apply({ approved: false, currentVerificationBinding: "verify:a" });
  assert.equal(candidate.state, "accepted");
  assert.equal(candidate.events.at(-1).type, "apply-declined");
});

test("successful completion rejects an undisposed nonempty candidate", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  assert.throws(() => candidate.successfulWorkflowCompletion(), /undisposed nonempty candidate/);
});

test("successful completion automatically discards an unchanged candidate", () => {
  const candidate = new CandidateLifecycle();
  candidate.freeze();
  candidate.successfulWorkflowCompletion();
  assert.equal(candidate.state, "discarded");
  assert.equal(candidate.events.at(-1).reason, "unchanged candidate");
});

test("failure stop or cancellation abandons pending work and rejects pending measurement", () => {
  for (const reason of ["workflow-failed", "workflow-stopped", "branch-cancelled"]) {
    const candidate = new CandidateLifecycle();
    candidate.mutate();
    candidate.freeze({ measurement: true });
    candidate.terminate(reason);
    assert.equal(candidate.state, "abandoned");
    assert.equal(candidate.measurement, "rejected");
    assert.equal(candidate.events.at(-1).reason, reason);
  }
});

test("failure during mutable callback abandons the workspace", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.terminate("callback-failed");
  assert.equal(candidate.state, "abandoned");
});

test("pause preserves candidate state without disposition", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  candidate.pause();
  assert.equal(candidate.state, "pending");
});

test("pending measurements must be finalized by the exact disposition", () => {
  const accepted = new CandidateLifecycle();
  accepted.mutate();
  accepted.freeze({ measurement: true });
  assert.throws(() => accepted.accept({ verification: passed }), /pending measurement/);
  accepted.accept({ verification: passed, measurement: true });
  assert.equal(accepted.measurement, "accepted");

  const rejected = new CandidateLifecycle();
  rejected.mutate();
  rejected.freeze({ measurement: true });
  rejected.reject({ reason: "regressed", measurement: true });
  assert.equal(rejected.measurement, "rejected");
});

test("one candidate cannot receive two dispositions", () => {
  const candidate = new CandidateLifecycle();
  candidate.mutate();
  candidate.freeze();
  candidate.reject({ reason: "not useful" });
  assert.throws(() => candidate.accept({ verification: passed }), /candidate is rejected/);
  assert.throws(() => candidate.reject({ reason: "again" }), /candidate is rejected/);
});

test("ownership rejects one mutable workspace across sibling lanes", () => {
  const ownership = new WorkspaceLaneOwnership();
  ownership.use("workspace-a", [["group-1", "left"]]);
  ownership.use("workspace-a", [["group-1", "left"]]);
  assert.throws(
    () => ownership.use("workspace-a", [["group-1", "right"]]),
    /shared by sibling lanes/,
  );
});

test("independent candidate workspaces are safe in sibling lanes", () => {
  const ownership = new WorkspaceLaneOwnership();
  ownership.use("workspace-a", [["group-1", "left"]]);
  ownership.use("workspace-b", [["group-1", "right"]]);
});
