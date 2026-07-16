import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NamedWorkflowClient } from "../runtime/named-workflow-types.js";
import { registerWorkflowAliasCommand } from "./workflow-alias-command.js";

export function registerExecutePlanCommand(pi: ExtensionAPI, workflows: NamedWorkflowClient): void {
  registerWorkflowAliasCommand(pi, "execute-plan", "builtin:execute-plan", workflows);
}
