// Executable oracle for the workflow runtime conformance contract.
export class CandidateLifecycle {
  #state = "mutable";
  #changed = false;
  #measurement = "none";
  #events = [];
  #verificationBinding = null;

  get state() { return this.#state; }
  get changed() { return this.#changed; }
  get measurement() { return this.#measurement; }
  get events() { return this.#events.map((event) => ({ ...event })); }

  mutate() {
    this.#require("mutable");
    this.#changed = true;
    this.#record("mutated");
  }

  freeze({ measurement = false } = {}) {
    this.#require("mutable");
    this.#state = "pending";
    this.#measurement = measurement ? "pending" : "none";
    this.#record("frozen", { changed: this.#changed, measurement: this.#measurement });
  }

  accept({ verification, measurement = false }) {
    this.#require("pending");
    if (!this.#changed) throw new Error("unchanged candidate cannot be accepted");
    if (!verification || verification.passed !== true || typeof verification.binding !== "string") {
      throw new Error("acceptance requires passed bound verification");
    }
    if (measurement && this.#measurement !== "pending") throw new Error("acceptance measurement is not pending");
    if (!measurement && this.#measurement === "pending") throw new Error("pending measurement requires disposition evidence");
    this.#state = "accepted";
    this.#verificationBinding = verification.binding;
    if (this.#measurement === "pending") this.#measurement = "accepted";
    this.#record("accepted", { verification: verification.binding, measurement: this.#measurement });
  }

  reject({ reason, measurement = false }) {
    this.#require("pending");
    if (typeof reason !== "string" || !reason.trim()) throw new Error("rejection requires a reason");
    if (measurement && this.#measurement !== "pending") throw new Error("rejection measurement is not pending");
    if (!measurement && this.#measurement === "pending") throw new Error("pending measurement requires disposition evidence");
    this.#state = "rejected";
    if (this.#measurement === "pending") this.#measurement = "rejected";
    this.#record("rejected", { reason, measurement: this.#measurement });
  }

  apply({ approved, currentVerificationBinding }) {
    this.#require("accepted", "applied");
    if (this.#state === "applied") return;
    if (currentVerificationBinding !== this.#verificationBinding) {
      throw new Error("accepted verification is stale");
    }
    if (!approved) {
      this.#record("apply-declined");
      return;
    }
    this.#state = "applied";
    this.#record("applied");
  }

  successfulWorkflowCompletion() {
    if (this.#state === "mutable") throw new Error("mutable candidate escaped its resource scope");
    if (this.#state === "pending" && this.#changed) {
      throw new Error("successful workflow completion has an undisposed nonempty candidate");
    }
    if (this.#state === "pending") {
      this.#state = "discarded";
      this.#record("discarded", { reason: "unchanged candidate" });
    }
  }

  terminate(reason) {
    if (["mutable", "pending"].includes(this.#state)) {
      this.#state = "abandoned";
      if (this.#measurement === "pending") this.#measurement = "rejected";
      this.#record("abandoned", { reason, measurement: this.#measurement });
    }
  }

  pause() {
    this.#record("paused", { state: this.#state });
  }

  #require(...expected) {
    if (!expected.includes(this.#state)) {
      throw new Error(`candidate is ${this.#state}, expected ${expected.join(" or ")}`);
    }
  }

  #record(type, fields = {}) {
    this.#events.push(Object.freeze({ type, ...fields }));
  }
}

/** Structural ownership, independent from actual scheduler overlap. */
export class WorkspaceLaneOwnership {
  #owners = new Map();

  use(workspace, lineage) {
    for (const [group, lane] of lineage) {
      const key = `${workspace}\0${group}`;
      const owner = this.#owners.get(key);
      if (owner !== undefined && owner !== lane) {
        throw new Error(`workspace ${workspace} is shared by sibling lanes ${owner} and ${lane}`);
      }
      this.#owners.set(key, lane);
    }
  }
}
