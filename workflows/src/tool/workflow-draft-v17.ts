import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import type { WorkflowV17DraftService } from "../drafts/service-v17.js";
import type { WorkflowDraftNamespace } from "../drafts/types.js";
import { projectWorkflowV17DraftReview } from "../projection/approval-inspectors-v17.js";
import { stableJson } from "../utils/stable-json.js";
import { truncateBytes } from "../utils/truncate.js";

const HASH_PATTERN = "^sha256:[a-f0-9]{64}$";

export const WORKFLOW_V17_DRAFT_TOOL_SCHEMA = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("validate")]),
  namespace: Type.Union([Type.Literal("user"), Type.Literal("project")]),
  name: Type.String({ pattern: FLOW_NAME_PATTERN.source, maxLength: 64 }),
  source: Type.Optional(Type.String({ maxLength: DEFINITION_LIMITS.sourceBytes })),
  expectedDraftHash: Type.Optional(Type.String({ pattern: HASH_PATTERN })),
}, { additionalProperties: false });

/** Registered in place of the v16 draft tool only during the phase-16 atomic cutover. */
export function registerWorkflowV17DraftTool(pi: ExtensionAPI, drafts: WorkflowV17DraftService): void {
  pi.registerTool({
    name: "workflow_draft",
    label: "Workflow Draft",
    description: "Create, replace, or strictly validate an inert TypeScript .flow.ts draft. This tool cannot expose, promote, install, or execute source.",
    promptSnippet: "Stage or strictly validate inert TypeScript workflow source; cannot promote it",
    promptGuidelines: [
      "Use workflow_draft only to create, compare-and-swap replace, or validate inert .flow.ts source; workflow_draft cannot promote, expose, install, or approve its draft.",
    ],
    parameters: WORKFLOW_V17_DRAFT_TOOL_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const namespace = params.namespace as WorkflowDraftNamespace;
      const selector = `${namespace}:${params.name}`;
      return await withFileMutationQueue(drafts.store.headPath(namespace, params.name, ctx.cwd), async () => {
        if (params.action === "create") {
          if (params.source === undefined) throw new Error("workflow_draft create requires TypeScript source");
          if (params.expectedDraftHash !== undefined) throw new Error("workflow_draft create does not accept expectedDraftHash");
          const draft = await drafts.create({ namespace, name: params.name, source: params.source }, ctx);
          return result(`Created v17 draft ${draft.id} at ${draft.sourceHash}`, {
            runtimeVersion: 17, action: "create", draftId: draft.id, sourceHash: draft.sourceHash,
          });
        }
        if (params.action === "replace") {
          if (params.source === undefined || params.expectedDraftHash === undefined) {
            throw new Error("workflow_draft replace requires source and expectedDraftHash");
          }
          const draft = await drafts.replace({
            namespace,
            name: params.name,
            source: params.source,
            expectedSourceHash: params.expectedDraftHash,
          }, ctx);
          return result(`Replaced v17 draft ${draft.id} with ${draft.sourceHash}`, {
            runtimeVersion: 17, action: "replace", draftId: draft.id, sourceHash: draft.sourceHash,
          });
        }
        if (params.source !== undefined || params.expectedDraftHash !== undefined) {
          throw new Error("workflow_draft validate accepts only action, namespace, and name");
        }
        const review = await drafts.validate(selector, ctx);
        const projection = projectWorkflowV17DraftReview(review);
        const rendered = truncateBytes(
          `${review.valid ? "Valid" : "Invalid"} v17 draft ${review.draftId} · review ${review.reviewHash}\n${stableJson(projection)}`,
          48 * 1024,
          "\n[… validation truncated; use /flow validate for the bounded review …]",
        );
        return result(rendered, {
          runtimeVersion: 17, action: "validate", draftId: review.draftId,
          sourceHash: review.sourceHash, review: projection,
        });
      });
    },
  });
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}
