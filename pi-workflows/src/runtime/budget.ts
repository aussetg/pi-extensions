import { WorkflowAbortError, WorkflowBudgetExceededError } from "./errors.js";

export interface WorkflowBudgetReservation {
  release(): void;
}

const NOOP_RESERVATION: WorkflowBudgetReservation = Object.freeze({ release: () => undefined });

export class WorkflowBudget {
  private used = 0;
  private reserved = false;
  private readonly waiters: Array<() => void> = [];

  constructor(public readonly total: number | null) {}

  spent(): number {
    return this.used;
  }

  remaining(): number {
    return this.total === null ? Number.POSITIVE_INFINITY : Math.max(0, this.total - this.used);
  }

  charge(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.used += Math.ceil(tokens);
  }

  assertCanStart(): void {
    if (this.total !== null && this.used >= this.total) throw new WorkflowBudgetExceededError();
  }

  assertWithinBudget(): void {
    if (this.total !== null && this.used > this.total) {
      throw new WorkflowBudgetExceededError(`Workflow token budget exhausted (${this.used}/${this.total})`);
    }
  }

  async reserveExclusive(signal?: AbortSignal): Promise<WorkflowBudgetReservation> {
    if (this.total === null) return NOOP_RESERVATION;

    while (this.reserved) {
      this.assertCanStart();
      await this.waitForReservation(signal);
    }

    this.assertCanStart();
    this.reserved = true;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reserved = false;
        if (this.total !== null && this.used >= this.total) this.wakeAllWaiters();
        else this.waiters.shift()?.();
      },
    };
  }

  private wakeAllWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  private async waitForReservation(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowAbortError();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new WorkflowAbortError());
      };
      const cleanup = () => {
        const index = this.waiters.indexOf(wake);
        if (index !== -1) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
