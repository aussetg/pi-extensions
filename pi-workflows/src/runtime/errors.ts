export class WorkflowScriptError extends Error {
  constructor(message: string, public readonly location?: { line?: number; column?: number }) {
    super(location?.line ? `${message} (${location.line}:${location.column ?? 0})` : message);
    this.name = "WorkflowScriptError";
  }
}

export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}

export class WorkflowBudgetExceededError extends Error {
  constructor(message = "Workflow token budget exhausted") {
    super(message);
    this.name = "WorkflowBudgetExceededError";
  }
}

export class WorkflowAgentCapError extends Error {
  constructor(message = "Workflow agent cap exceeded") {
    super(message);
    this.name = "WorkflowAgentCapError";
  }
}

export class WorkflowSkipAgentError extends Error {
  constructor(public readonly callId: string) {
    super(`Workflow agent ${callId} skipped`);
    this.name = "WorkflowSkipAgentError";
  }
}
