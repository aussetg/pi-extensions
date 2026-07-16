export class WorkflowScriptError extends Error {
  constructor(message: string, public readonly location?: { line?: number; column?: number }) {
    super(location?.line ? `${message} (${location.line}:${location.column ?? 0})` : message);
    this.name = "WorkflowScriptError";
  }
}
