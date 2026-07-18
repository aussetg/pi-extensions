/** Installed workflow identity shared by registry, drafts, and durable host requests. */
export type WorkflowNamespace = "builtin" | "user" | "project";
export type WorkflowId = `${WorkflowNamespace}:${string}`;
