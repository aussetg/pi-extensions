import { WorkflowBudgetExceededError } from "./errors.js";

export class WorkflowBudget {
  private used = 0;

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
}
