import { WorkflowAbortError, WorkflowSkipAgentError } from "./errors.js";

export class RunControl {
  readonly controller = new AbortController();
  private paused = false;
  private waiters: Array<() => void> = [];
  private activeAgents = new Map<string, ActiveAgent>();
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
    for (const agent of this.activeAgents.values()) agent.controller.abort(new WorkflowAbortError(reason));
    this.resume();
  }

  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    this.throwIfAborted();
    throwIfExternalAborted(signal);
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(abortError(this.controller.signal, signal));
      };
      const waiter = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.controller.signal.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
      };
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      if (signal?.aborted) onAbort();
    });
    this.throwIfAborted();
    throwIfExternalAborted(signal);
  }

  throwIfAborted(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason instanceof Error ? this.controller.signal.reason : new WorkflowAbortError();
  }

  registerAgent(callId: string, signal?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (this.skipped.has(callId)) controller.abort(new WorkflowSkipAgentError(callId));
    else if (this.controller.signal.aborted) controller.abort(new WorkflowAbortError());
    else if (signal?.aborted) controller.abort(abortError(this.controller.signal, signal));
    else {
      const abortWorkflow = () => controller.abort(this.controller.signal.reason ?? new WorkflowAbortError());
      const abortExternal = () => controller.abort(abortError(this.controller.signal, signal));
      this.controller.signal.addEventListener("abort", abortWorkflow, { once: true });
      signal?.addEventListener("abort", abortExternal, { once: true });
      this.activeAgents.set(callId, {
        controller,
        cleanup: () => {
          this.controller.signal.removeEventListener("abort", abortWorkflow);
          signal?.removeEventListener("abort", abortExternal);
        },
      });
      return controller;
    }
    this.activeAgents.set(callId, { controller, cleanup: () => undefined });
    return controller;
  }

  unregisterAgent(callId: string): void {
    const active = this.activeAgents.get(callId);
    active?.cleanup();
    this.activeAgents.delete(callId);
  }

  skipAgent(callId: string): boolean {
    this.skipped.add(callId);
    const active = this.activeAgents.get(callId);
    if (active) active.controller.abort(new WorkflowSkipAgentError(callId));
    return Boolean(active);
  }

  isSkipped(callId: string): boolean {
    return this.skipped.has(callId);
  }
}

interface ActiveAgent {
  controller: AbortController;
  cleanup(): void;
}

function throwIfExternalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(undefined, signal);
}

function abortError(workflowSignal?: AbortSignal, externalSignal?: AbortSignal): Error {
  if (workflowSignal?.aborted) return workflowSignal.reason instanceof Error ? workflowSignal.reason : new WorkflowAbortError();
  if (externalSignal?.aborted) return externalSignal.reason instanceof Error ? externalSignal.reason : new WorkflowAbortError();
  return new WorkflowAbortError();
}
