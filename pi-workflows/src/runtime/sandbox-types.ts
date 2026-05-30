export interface SandboxGlobals {
  agent: (...args: unknown[]) => Promise<unknown>;
  phase: (title: string) => void | Promise<void>;
  log: (message: string) => void | Promise<void>;
  workflow: (...args: unknown[]) => Promise<unknown>;
  ui: unknown;
  args: unknown;
  budget: unknown;
  cwd: string;
}
