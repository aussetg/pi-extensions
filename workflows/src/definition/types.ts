/** Namespace and authority primitives shared by registry, drafts, and durable host requests. */
export const WORKFLOW_CAPABILITIES = [
  "read-project",
  "candidate-write",
  "host-command",
  "mediated-network",
  "human-input",
] as const;

export type WorkflowCapability = (typeof WORKFLOW_CAPABILITIES)[number];
export type WorkflowNamespace = "builtin" | "user" | "project";
export type WorkflowId = `${WorkflowNamespace}:${string}`;
