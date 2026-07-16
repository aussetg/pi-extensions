import type { OperationKind, OperationRecord } from "./durable-types.js";
import type { SemanticEngineScope } from "./semantic-engine-types.js";
import { stableHash } from "../utils/hashes.js";
import {
  normalizeConditionResult,
  normalizeFanOut,
  normalizeLoopOptions,
  normalizeParallelBranches,
  normalizeParallelOptions,
  operationKey,
} from "./semantic-structure-values.js";

export interface StructuralPreclaim {
  path: string;
  sourceId: string;
  semanticInputHash: string;
}

export interface StructuralBranchBinding {
  groupId: string;
  key: string;
  signal: AbortSignal;
}

export interface StructuredConcurrencyHooks {
  readonly concurrency: number;
  structuralOperation<T>(
    kind: Extract<OperationKind, "loop" | "parallel" | "fan-out">,
    id: unknown,
    semanticInputHash: string,
    body: (operation: OperationRecord, scope: SemanticEngineScope) => Promise<T>,
  ): Promise<T>;
  preclaim(parent: OperationRecord, specs: readonly StructuralPreclaim[]): Promise<OperationRecord[]>;
  children(parentOperationId: string): OperationRecord[];
  runPreclaimedChild<T>(
    parent: SemanticEngineScope,
    operation: OperationRecord,
    body: () => unknown,
    branch?: StructuralBranchBinding,
  ): Promise<T>;
  branchFailure(error: unknown, branch: OperationRecord): Record<string, unknown>;
  isPassthrough(error: unknown): boolean;
  cancelSiblings(error: unknown): boolean;
  branchSettled?(operationPath: string): void;
}

/** Host-side implementation of deterministic structured control primitives. */
export class StructuredConcurrencyRuntime {
  constructor(private readonly hooks: StructuredConcurrencyHooks) {}

  async loop(id: unknown, optionsValue: unknown, bodyValue: unknown): Promise<unknown> {
    const options = normalizeLoopOptions(optionsValue);
    if (typeof bodyValue !== "function") throw new Error("flow.loop() body must be a callback");
    const semanticInputHash = stableHash({
      title: options.title ?? null,
      maxIterations: options.maxIterations,
      mode: options.mode,
    });
    return await this.hooks.structuralOperation("loop", id, semanticInputHash, async (operation, scope) => {
      const existing = this.hooks.children(operation.operationId);
      if (existing.length > options.maxIterations) throw new Error(`Loop ${operation.path} exceeds its declared iteration limit`);
      let iterations = 0;
      let last: unknown;

      for (const child of existing) {
        const spec = iterationSpec(operation, iterations);
        assertPreclaimedIdentity(child, spec, operation.operationId);
        last = await this.hooks.runPreclaimedChild(scope, child, () => Promise.resolve(
          (bodyValue as (context: { iteration: number }) => unknown)({ iteration: iterations }),
        ));
        iterations++;
      }

      while (true) {
        const condition = normalizeConditionResult(await Promise.resolve(options.condition()));
        const shouldContinue = options.mode === "while" ? condition.result : !condition.result;
        if (!shouldContinue) return { iterations, ...(iterations > 0 ? { last } : {}), stoppedBy: "condition" };
        if (iterations >= options.maxIterations) {
          return { iterations, ...(iterations > 0 ? { last } : {}), stoppedBy: "limit" };
        }
        const [child] = await this.hooks.preclaim(operation, [iterationSpec(operation, iterations)]);
        last = await this.hooks.runPreclaimedChild(scope, child!, () => Promise.resolve(
          (bodyValue as (context: { iteration: number }) => unknown)({ iteration: iterations }),
        ));
        iterations++;
      }
    });
  }

  async parallel(id: unknown, branchesValue: unknown, optionsValue: unknown): Promise<unknown> {
    const branches = normalizeParallelBranches(branchesValue);
    const options = normalizeParallelOptions(optionsValue);
    const keys = branches.map((branch) => branch.key);
    const semanticInputHash = stableHash({
      title: options.title ?? null,
      concurrency: options.concurrency ?? null,
      failure: options.failure,
      keys,
    });
    return await this.hooks.structuralOperation("parallel", id, semanticInputHash, async (operation, scope) => {
      const specs = keys.map((key, index) => branchSpec(operation, key, index, "branch"));
      const rows = await this.preclaimExact(operation, specs);
      const controller = linkedController(scope.signal);
      try {
        const values = await runBounded(
          branches,
          Math.min(options.concurrency ?? this.hooks.concurrency, this.hooks.concurrency),
          controller,
          (error) => this.hooks.cancelSiblings(error),
          async (branch, index) => await this.runBranch(
            scope,
            rows[index]!,
            branch.key,
            branch.body,
            options.failure,
            controller.signal,
          ),
        );
        const result: Record<string, unknown> = Object.create(null);
        for (let index = 0; index < branches.length; index++) result[branches[index]!.key] = values[index];
        return result;
      } finally {
        controller.dispose();
      }
    });
  }

  async fanOut(id: unknown, itemsValue: unknown, optionsValue: unknown, bodyValue: unknown): Promise<unknown> {
    const normalized = normalizeFanOut(itemsValue, optionsValue, bodyValue);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < normalized.items.length; index++) {
      const key = operationKey(await Promise.resolve(normalized.options.key(normalized.items[index], index)), "fanOut item");
      if (seen.has(key)) throw new Error(`Duplicate fanOut item key ${key}`);
      seen.add(key);
      keys.push(key);
    }
    const semanticInputHash = stableHash({
      title: normalized.options.title ?? null,
      concurrency: normalized.options.concurrency ?? null,
      failure: normalized.options.failure,
      keys,
    });
    return await this.hooks.structuralOperation("fan-out", id, semanticInputHash, async (operation, scope) => {
      const specs = keys.map((key, index) => branchSpec(operation, key, index, "item"));
      const rows = specs.length === 0 ? [] : await this.preclaimExact(operation, specs);
      const controller = linkedController(scope.signal);
      try {
        return await runBounded(
          normalized.items,
          Math.min(normalized.options.concurrency ?? this.hooks.concurrency, this.hooks.concurrency),
          controller,
          (error) => this.hooks.cancelSiblings(error),
          async (item, index) => await this.runBranch(
            scope,
            rows[index]!,
            keys[index]!,
            () => normalized.body(item, { key: keys[index]!, index }),
            normalized.options.failure,
            controller.signal,
          ),
        );
      } finally {
        controller.dispose();
      }
    });
  }

  private async preclaimExact(
    parent: OperationRecord,
    specs: readonly StructuralPreclaim[],
  ): Promise<OperationRecord[]> {
    const rows = await this.hooks.preclaim(parent, specs);
    if (rows.length !== specs.length) throw new Error(`Structural queue ${parent.path} is incomplete`);
    for (let index = 0; index < rows.length; index++) {
      assertPreclaimedIdentity(rows[index]!, specs[index]!, parent.operationId);
    }
    return rows;
  }

  private async runBranch(
    scope: SemanticEngineScope,
    operation: OperationRecord,
    key: string,
    body: () => unknown,
    failure: "fail-fast" | "collect",
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      const value = await this.hooks.runPreclaimedChild(scope, operation, body, {
        groupId: operation.parentOperationId!, key, signal,
      });
      return failure === "collect" ? { ok: true, value } : value;
    } catch (error) {
      if (failure !== "collect" || this.hooks.isPassthrough(error)) throw error;
      return { ok: false, failure: this.hooks.branchFailure(error, operation) };
    } finally {
      this.hooks.branchSettled?.(operation.path);
    }
  }
}

function iterationSpec(parent: OperationRecord, iteration: number): StructuralPreclaim {
  const key = `iteration-${String(iteration).padStart(6, "0")}`;
  return {
    path: `${parent.path}/iteration:${String(iteration).padStart(6, "0")}`,
    sourceId: key,
    semanticInputHash: stableHash({ role: "iteration", iteration }),
  };
}

function branchSpec(
  parent: OperationRecord,
  key: string,
  index: number,
  role: "branch" | "item",
): StructuralPreclaim {
  return {
    path: `${parent.path}/${role}:${key}`,
    sourceId: key,
    semanticInputHash: stableHash({ role, key, index }),
  };
}

function assertPreclaimedIdentity(
  operation: OperationRecord,
  spec: StructuralPreclaim,
  parentOperationId: string,
): void {
  if (
    operation.kind !== "stage"
    || operation.parentOperationId !== parentOperationId
    || operation.path !== spec.path
    || operation.sourceId !== spec.sourceId
    || operation.semanticInputHash !== spec.semanticInputHash
  ) throw new Error(`Structural queue row ${operation.path} changed identity`);
}

async function runBounded<T, R>(
  entries: readonly T[],
  concurrency: number,
  controller: AbortController,
  cancelSiblings: (error: unknown) => boolean,
  run: (entry: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (entries.length === 0) return [];
  const results = new Array<R>(entries.length);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor++;
      if (index >= entries.length) return;
      try {
        results[index] = await run(entries[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          if (cancelSiblings(error) && !controller.signal.aborted) controller.abort(error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  if (failed) throw firstError;
  return results;
}

function linkedController(parent: AbortSignal): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const abort = () => { if (!controller.signal.aborted) controller.abort(parent.reason); };
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  controller.dispose = () => parent.removeEventListener("abort", abort);
  return controller;
}
