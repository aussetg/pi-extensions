export interface SandboxRpcContext {
  signal: AbortSignal;
}

export interface SandboxGlobals {
  agent: (prompt: unknown, opts?: unknown, context?: SandboxRpcContext) => Promise<unknown>;
  apply: (patch: unknown, context?: SandboxRpcContext) => Promise<unknown>;
  phase: (title: string) => void | Promise<void>;
  log: (message: string) => void | Promise<void>;
  workflow: (nameOrRef: unknown, args?: unknown, context?: SandboxRpcContext) => Promise<unknown>;
  ui: unknown;
  args: unknown;
  budget: unknown;
  cwd: string;
}
