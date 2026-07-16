import { describeOpaqueCandidateWorkspace } from "../candidates/refs.js";
import { isCandidateWorkspaceCapability } from "../candidates/store.js";

export interface SemanticConcurrencyLease {
  release(): void;
}

interface Waiter {
  signal: AbortSignal;
  resolve: (lease: SemanticConcurrencyLease) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

/** One FIFO machine-wide limiter for effect launches within a run engine. */
export class SemanticConcurrencyLimiter {
  private readonly queue: Waiter[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private activeCount = 0;
  private closedReason: unknown;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Semantic concurrency limit must be positive");
  }

  get active(): number {
    return this.activeCount;
  }

  async acquire(signal: AbortSignal): Promise<SemanticConcurrencyLease> {
    if (this.closedReason !== undefined) throw this.closedReason;
    if (signal.aborted) throw abortReason(signal);
    if (this.activeCount < this.limit && this.queue.length === 0) return this.grant();
    return await new Promise<SemanticConcurrencyLease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  async whenIdle(): Promise<void> {
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  close(reason: unknown): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const waiter of this.queue.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(reason);
    }
  }

  private grant(): SemanticConcurrencyLease {
    this.activeCount++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeCount--;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.activeCount < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve(this.grant());
    }
    if (this.activeCount === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
}

export class CandidateConcurrencyError extends Error {
  constructor(readonly workspace: string, readonly groupId: string) {
    super("One mutable candidate workspace cannot be shared by concurrent branches");
    this.name = "CandidateConcurrencyError";
  }
}

/**
 * Remembers which deterministic branch owns each mutable workspace. The check
 * is structural, not timing-dependent: lowering machine concurrency cannot
 * accidentally make an unsafe workflow valid.
 */
export class CandidateConcurrencyGuard {
  private readonly owners = new Map<string, Map<string, string>>();
  private readonly capabilityOwners = new WeakMap<object, Map<string, string>>();

  constructor(private readonly runId: string) {}

  assertSafe(value: unknown, branchLineage: ReadonlyMap<string, string>): void {
    if (branchLineage.size === 0) return;
    for (const workspace of candidateWorkspaces(value)) {
      if (workspace.descriptor && workspace.descriptor.runId !== this.runId) {
        throw new Error("Candidate workspace belongs to another run");
      }
      const identity = workspace.descriptor
        ? `${workspace.descriptor.runId}\0${workspace.descriptor.logicalPath}\0${workspace.descriptor.attempt}`
        : undefined;
      let groups = identity ? this.owners.get(identity) : this.capabilityOwners.get(workspace.value);
      if (!groups) groups = new Map();
      if (identity) this.owners.set(identity, groups);
      else this.capabilityOwners.set(workspace.value, groups);
      for (const [groupId, branchKey] of branchLineage) {
        const owner = groups.get(groupId);
        if (owner !== undefined && owner !== branchKey) {
          throw new CandidateConcurrencyError(
            workspace.descriptor?.logicalPath ?? "opaque-candidate-workspace",
            groupId,
          );
        }
        groups.set(groupId, branchKey);
      }
    }
  }
}

function candidateWorkspaces(value: unknown): Array<{
  value: object;
  descriptor?: NonNullable<ReturnType<typeof describeOpaqueCandidateWorkspace>>;
}> {
  const found: Array<{
    value: object;
    descriptor?: NonNullable<ReturnType<typeof describeOpaqueCandidateWorkspace>>;
  }> = [];
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (++nodes > 50_000) throw new Error("Effect input exceeds the workspace-safety traversal limit");
    const workspace = describeOpaqueCandidateWorkspace(current);
    if (workspace) {
      found.push({ value: current, descriptor: workspace });
      return;
    }
    if (candidateCapability(current)) {
      found.push({ value: current });
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current)) as PropertyDescriptor[]) {
      if (descriptor.enumerable && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  return found;
}

function candidateCapability(value: unknown): boolean {
  return isCandidateWorkspaceCapability(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error("Semantic effect launch was cancelled");
}
