import { WorkflowAbortError, WorkflowSkipAgentError } from "./errors.js";

export class RunControl {
  readonly controller = new AbortController();
  private paused = false;
  private waiters: Array<() => void> = [];
  private activeAgents = new Map<string, AbortController>();
  private skipped = new Set<string>();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  stop(reason = "Workflow stopped"): void {
    if (!this.controller.signal.aborted) this.controller.abort(new WorkflowAbortError(reason));
    for (const agent of this.activeAgents.values()) agent.abort(new WorkflowAbortError(reason));
    this.resume();
  }

  async waitIfPaused(): Promise<void> {
    this.throwIfAborted();
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new WorkflowAbortError());
      };
      const cleanup = () => this.controller.signal.removeEventListener("abort", onAbort);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => {
        cleanup();
        resolve();
      });
    });
    this.throwIfAborted();
  }

  throwIfAborted(): void {
    if (this.controller.signal.aborted) throw new WorkflowAbortError();
  }

  registerAgent(callId: string): AbortController {
    const controller = new AbortController();
    if (this.skipped.has(callId)) controller.abort(new WorkflowSkipAgentError(callId));
    else if (this.controller.signal.aborted) controller.abort(new WorkflowAbortError());
    else {
      const abort = () => controller.abort(this.controller.signal.reason ?? new WorkflowAbortError());
      this.controller.signal.addEventListener("abort", abort, { once: true });
    }
    this.activeAgents.set(callId, controller);
    return controller;
  }

  unregisterAgent(callId: string): void {
    this.activeAgents.delete(callId);
  }

  skipAgent(callId: string): boolean {
    this.skipped.add(callId);
    const active = this.activeAgents.get(callId);
    if (active) active.abort(new WorkflowSkipAgentError(callId));
    return Boolean(active);
  }

  isSkipped(callId: string): boolean {
    return this.skipped.has(callId);
  }
}
