import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowInput, WorkflowLaunchOutput, ToolResult } from "../types.js";
import type { RunStore } from "../persistence/run-store.js";
import type { WorkflowRegistry } from "../persistence/registry.js";
import { WorkflowRunner } from "../runtime/runner.js";
import { WORKFLOW_PROMPT_GUIDELINES, WORKFLOW_TOOL_DESCRIPTION } from "./prompt-guidance.js";
import { renderWorkflowCall, renderWorkflowResult } from "./workflow-tool-renderer.js";

const StringEnum = <T extends readonly string[]>(values: T, options: Record<string, unknown> = {}) => Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });

const WorkflowSourceInputProperties = {
  script: Type.Optional(Type.String({ minLength: 1, maxLength: 524_288, description: "Inline workflow JavaScript. Must begin with export const meta = {...}." })),
  name: Type.Optional(Type.String({ minLength: 1, description: "Saved workflow name from the registry." })),
  scriptPath: Type.Optional(Type.String({ minLength: 1, description: "Path to a workflow JavaScript file." })),
};

const WorkflowCommonInputProperties = {
  args: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true, description: "JSON arguments exposed as the args global." })),
  resumeFromRunId: Type.Optional(Type.String({ minLength: 1, description: "Prior run id to record as lineage. Agent results are never replayed." })),
  mode: Type.Optional(StringEnum(["async", "await"] as const)),
  budgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
};

export const WorkflowInputSchema = Type.Object(
  {
    ...WorkflowSourceInputProperties,
    ...WorkflowCommonInputProperties,
  },
  {
    additionalProperties: false,
    description: "Workflow input. Provide exactly one of script, name, or scriptPath. This is enforced by the workflow runner after tool input parsing.",
  },
);

export interface WorkflowToolDeps {
  pi: ExtensionAPI;
  runStore: RunStore;
  registry: WorkflowRegistry;
}

export function createWorkflowTool(deps: WorkflowToolDeps): any {
  return {
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: "Run deterministic JavaScript workflows only for complex/non-standard orchestration that requires multiple Pi subagents; avoid for sequential or single-agent work.",
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowInputSchema,
    renderCall: (args: Record<string, unknown>, theme: any) => renderWorkflowCall(args, theme),
    renderResult: (result: any, options: any, theme: any, context: any) => renderWorkflowResult(result, options, theme, context),
    async execute(toolCallId: string, input: WorkflowInput, signal: AbortSignal, onUpdate: (partial: ToolResult<WorkflowLaunchOutput>) => void, ctx: any): Promise<ToolResult<WorkflowLaunchOutput>> {
      try {
        const runner = new WorkflowRunner(deps);
        const result = await runner.launchOrRun({ toolCallId, input, signal, onUpdate, ctx });
        return {
          content: [{ type: "text", text: result.summary }],
          details: result,
          isError: result.status === "failed" || undefined,
        };
      } catch (err) {
        const result = failedBeforeLaunch(toolCallId, input, err);
        return {
          content: [{ type: "text", text: result.summary }],
          details: result,
          isError: true,
        };
      }
    },
  };
}

function failedBeforeLaunch(toolCallId: string, input: WorkflowInput, err: unknown): WorkflowLaunchOutput {
  const message = (err as Error)?.message ?? String(err);
  const now = new Date().toISOString();
  const source = String(input?.name ?? input?.scriptPath ?? (input?.script ? "inline" : "unknown"));
  return {
    status: "failed",
    taskId: toolCallId,
    runId: "not-started",
    name: source,
    description: "Workflow failed before launch",
    summary: `Workflow failed before launch: ${message}`,
    scriptPath: input?.scriptPath ?? (input?.script ? "<inline>" : ""),
    transcriptDir: "",
    error: message,
    startedAt: now,
    endedAt: now,
  };
}
