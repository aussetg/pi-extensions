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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error("Semantic effect launch was cancelled");
}
