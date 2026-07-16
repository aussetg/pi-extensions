import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { JsonObject } from "../types.js";
import type { NamedWorkflowClient, NamedWorkflowResult } from "../runtime/named-workflow-types.js";
import { stableJson } from "../utils/stable-json.js";
import { truncateBytes } from "../utils/truncate.js";
import { boundFlowToolResultDetails, type FlowToolResultDetails } from "../ui/flow-protocol.js";
import { renderNamedWorkflowCall, renderNamedWorkflowResult } from "../ui/flow-tool-renderer.js";

const NAMED_WORKFLOW_TOOL_SCHEMA = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 72,
    pattern: "^(?:(?:builtin|user|project):)?[a-z][a-z0-9-]{0,63}$",
    description: "Exact registered workflow name, optionally namespace-qualified.",
  }),
  args: Type.Unsafe<JsonObject>({
    type: "object",
    maxProperties: 128,
    additionalProperties: true,
    description: "Arguments validated against the installed workflow revision.",
  }),
  mode: Type.Optional(Type.Union([
    Type.Literal("await"),
    Type.Literal("async"),
  ], { description: "Wait until the run settles, or launch it in the background." })),
}, { additionalProperties: false });

export type NamedWorkflowToolArguments = Static<typeof NAMED_WORKFLOW_TOOL_SCHEMA>;

/** The execution tool selects only an installed name, data, and delivery mode. */
export function registerNamedWorkflowTool(pi: ExtensionAPI, workflows: NamedWorkflowClient): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Run one reviewed, registered workflow through its per-run systemd coordinator.",
      "Arguments cannot select models, tools, commands, workspaces, approval decisions, or execution policy.",
      "Use workflow_draft to stage inert workflow text; this execution tool never accepts text to install or execute.",
    ].join(" "),
    promptSnippet: "Run a reviewed named workflow by name and validated arguments",
    promptGuidelines: [
      "Use workflow only with a registered name and that workflow's documented argument object.",
      "Use workflow mode=await unless the user explicitly asks for background execution.",
    ],
    parameters: NAMED_WORKFLOW_TOOL_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let latestProjection: FlowToolResultDetails["projection"];
      const result = await workflows.invoke(
        { name: params.name, args: params.args, mode: params.mode ?? "await" },
        "model",
        ctx,
        {
          ...(onUpdate ? {
            onUpdate: async (summary) => {
              latestProjection = await workflows.open(summary.runId, ctx);
              onUpdate({
                content: [{ type: "text", text: `Workflow ${summary.shortRunId}: ${summary.status}` }],
                details: boundFlowToolResultDetails({ formatVersion: 1, runId: summary.runId, projection: latestProjection }),
              });
            },
          } : {}),
        },
      );
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow tool was cancelled");
      latestProjection = await workflows.open(result.runId, ctx);
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: boundFlowToolResultDetails({
          formatVersion: 1,
          runId: result.runId,
          projection: latestProjection,
          ...(result.result !== undefined ? { resultPreview: truncateBytes(typeof result.result === "string" ? result.result : stableJson(result.result), 2_048) } : {}),
          ...(result.resultArtifact ? { resultArtifact: result.resultArtifact } : {}),
          handoff: result.handoff,
        }),
      };
    },
    renderCall(args, theme) {
      return renderNamedWorkflowCall(args as Partial<NamedWorkflowToolArguments>, theme);
    },
    renderResult(result, options, theme, context) {
      return renderNamedWorkflowResult(result as any, options, theme, context);
    },
  });
}

function resultText(result: NamedWorkflowResult): string {
  if (result.result !== undefined) {
    return truncateBytes(
      typeof result.result === "string" ? result.result : stableJson(result.result),
      48 * 1024,
      `\n[… result truncated; use /flow open ${result.summary.shortRunId} …]`,
    );
  }
  return result.handoff
    ? `Workflow ${result.summary.shortRunId} is ${result.status}. Use /flow open ${result.summary.shortRunId} to inspect it.`
    : `Workflow ${result.summary.shortRunId} ended ${result.status}.`;
}
