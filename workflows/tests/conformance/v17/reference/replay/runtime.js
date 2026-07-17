// Executable oracle for the workflow runtime v17 conformance contract.
import { hash } from "./model.js";

export class SimulatedCrash extends Error {
  constructor(readonlyPoint, path) {
    super(`crash at ${readonlyPoint} ${path}`);
    this.name = "SimulatedCrash";
    this.point = readonlyPoint;
    this.path = path;
  }
}

export class SameRunJournal {
  rows = new Map();
  executions = new Map();
  transitions = [];

  snapshot() {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

export class DurableRuntime {
  constructor(journal, options = {}) {
    this.journal = journal;
    this.crashAt = options.crashAt ?? null;
    this.transition = 0;
    this.scopes = [];
  }

  async run(program) {
    const root = { path: "run", cursor: 0 };
    return await this.#inScope(root, async () => await program(this));
  }

  async effect(name, input, execute) {
    const scope = this.#scope();
    const path = `${scope.path}/${pad(scope.cursor++)}`;
    const semantic = hash({ kind: "effect", input });
    let row = this.journal.rows.get(path);
    if (row) this.#assert(row, "effect", semantic);
    else {
      row = { path, name, kind: "effect", semantic, status: "running" };
      this.journal.rows.set(path, row);
      this.#fault("after-claim", path);
    }
    if (row.status === "completed") return structuredClone(row.result);
    if (row.status === "failed") throw recorded(row.error);

    if (!Object.hasOwn(row, "receipt")) {
      this.journal.executions.set(path, (this.journal.executions.get(path) ?? 0) + 1);
      try {
        row.receipt = structuredClone(await execute());
      } catch (error) {
        row.error = String(error instanceof Error ? error.message : error);
        row.status = "failed";
        this.#fault("after-failure", path);
        throw recorded(row.error);
      }
      this.#fault("after-settle", path);
    }

    row.result = structuredClone(row.receipt);
    row.status = "completed";
    this.#fault("after-complete", path);
    return structuredClone(row.result);
  }

  async candidate(name, body, options = {}) {
    const scope = this.#scope();
    const path = `${scope.path}/${pad(scope.cursor++)}`;
    const semantic = hash({ kind: "candidate", options });
    let row = this.journal.rows.get(path);
    if (row) this.#assert(row, "candidate", semantic);
    else {
      row = { path, name, kind: "candidate", semantic, status: "running" };
      this.journal.rows.set(path, row);
      this.#fault("after-claim", path);
    }
    if (row.status === "completed") return structuredClone(row.result);
    if (row.status === "failed") throw recorded(row.error);

    try {
      const child = { path: `${path}/candidate`, cursor: 0 };
      const output = await this.#inScope(child, async () => await body({ workspace: path }));
      this.#fault("after-candidate-body", path);
      row.result = { output: structuredClone(output), changedPaths: options.changedPaths ?? [] };
      row.status = "completed";
      this.#fault("after-candidate-complete", path);
      return structuredClone(row.result);
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      row.error = String(error instanceof Error ? error.message : error);
      row.status = "failed";
      this.#fault("after-failure", path);
      throw recorded(row.error);
    }
  }

  #assert(row, kind, semantic) {
    if (row.kind !== kind || row.semantic !== semantic) {
      throw new Error(`semantic operation mismatch at ${row.path}`);
    }
  }

  #scope() {
    const scope = this.scopes.at(-1);
    if (!scope) throw new Error("no active semantic scope");
    return scope;
  }

  async #inScope(scope, body) {
    this.scopes.push(scope);
    try { return await body(); }
    finally { this.scopes.pop(); }
  }

  #fault(point, path) {
    this.transition++;
    this.journal.transitions.push({ point, path });
    if (this.crashAt === this.transition) throw new SimulatedCrash(point, path);
  }
}

export async function recoverUntilComplete(program, options = {}) {
  const journal = options.journal ?? new SameRunJournal();
  let crashAt = options.firstCrashAt ?? 1;
  let crashes = 0;
  while (true) {
    try {
      const runtime = new DurableRuntime(journal, {
        crashAt: crashes < (options.maximumCrashes ?? 0) ? crashAt : null,
      });
      const result = await runtime.run(program);
      return { result, journal, crashes };
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error;
      crashes++;
      crashAt = options.repeatAtSameTransition ? crashAt : crashAt + 1;
      if (crashes > (options.maximumCrashes ?? 0)) throw error;
    }
  }
}

function recorded(message) {
  const error = new Error(message);
  error.name = "RecordedEffectError";
  return error;
}

function pad(value) {
  return String(value).padStart(6, "0");
}
