import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NamedWorkflowClient } from "../runtime/named-workflow-types.js";
import type { JsonValue } from "../types.js";
import { createFlowEnvelope } from "../ui/flow-protocol.js";
import { boundedProjectionText as sanitizeProjectionText } from "../projection/run-projection.js";
import { emitFlowEnvelope } from "./flow-command.js";

/** Friendly text parser; launch authority and persistence are exactly `/flow run`. */
export function registerWorkflowAliasCommand(
  pi: ExtensionAPI,
  commandName: "goal" | "execute-plan",
  workflow: "builtin:goal" | "builtin:execute-plan",
  workflows: NamedWorkflowClient,
): void {
  pi.registerCommand(commandName, {
    description: `Alias for /flow run ${workflow}`,
    handler: async (args, ctx) => {
      try {
        const objective = args.trim();
        if (!objective) throw new Error(`Usage: /${commandName} OBJECTIVE`);
        const result = await workflows.invoke(
          { name: workflow, args: { objective }, mode: "await" },
          ctx.mode === "rpc" ? "rpc" : "user",
          ctx,
        );
        emitFlowEnvelope(ctx, createFlowEnvelope({
          kind: "flow-run",
          ok: true,
          message: `${result.summary.workflowId} (${result.summary.shortRunId}) is ${result.status}`,
          data: {
            summary: result.summary,
            ...(result.result !== undefined ? { result: result.result } : {}),
            ...(result.resultArtifact ? { resultArtifact: result.resultArtifact } : {}),
          } as unknown as JsonValue,
        }));
      } catch (error) {
        const message = sanitizeProjectionText(error instanceof Error ? error.message : error, 2_048);
        emitFlowEnvelope(ctx, createFlowEnvelope({
          kind: "flow-error",
          ok: false,
          message,
          error: { name: error instanceof Error ? error.name : "Error", message },
        }));
      }
    },
  });
}
