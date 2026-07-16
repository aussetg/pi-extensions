import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import type { WorkflowDraftService } from "../drafts/service.js";
import type { WorkflowDraftNamespace } from "../drafts/types.js";
import { stableJson } from "../utils/stable-json.js";
import { truncateBytes } from "../utils/truncate.js";

const HASH_PATTERN = "^sha256:[a-f0-9]{64}$";

/** Deliberately excludes promotion, installation, command, model, and tool authority. */
const WORKFLOW_DRAFT_TOOL_SCHEMA = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("validate")]),
  namespace: Type.Union([Type.Literal("user"), Type.Literal("project")]),
  name: Type.String({ pattern: FLOW_NAME_PATTERN.source, maxLength: 64 }),
  source: Type.Optional(Type.String({ maxLength: DEFINITION_LIMITS.sourceBytes })),
  expectedDraftHash: Type.Optional(Type.String({ pattern: HASH_PATTERN })),
}, { additionalProperties: false });

export function registerWorkflowDraftTool(
  pi: ExtensionAPI,
  drafts: WorkflowDraftService,
): void {
  pi.registerTool({
    name: "workflow_draft",
    label: "Workflow Draft",
    description: "Create, replace, or statically validate a user/project workflow draft. This tool cannot promote or install a draft. Validation text is truncated to 48 KiB.",
    promptSnippet: "Stage or statically validate inert workflow source; cannot promote it",
    promptGuidelines: [
      "Use workflow_draft only to create, compare-and-swap replace, or validate inert workflow source; workflow_draft cannot promote, install, or approve its own draft.",
    ],
    parameters: WORKFLOW_DRAFT_TOOL_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const namespace = params.namespace as WorkflowDraftNamespace;
      const selector = `${namespace}:${params.name}`;
      const mutationPath = drafts.store.headPath(namespace, params.name, ctx.cwd);
      return await withFileMutationQueue(mutationPath, async () => {
        if (params.action === "create") {
          if (params.source === undefined) throw new Error("workflow_draft create requires source");
          if (params.expectedDraftHash !== undefined) throw new Error("workflow_draft create does not accept expectedDraftHash");
          const draft = await drafts.create({ namespace, name: params.name, source: params.source }, ctx);
          return result(`Created draft ${draft.id} at ${draft.sourceHash}`, {
            action: "create", draftId: draft.id, sourceHash: draft.sourceHash,
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
          return result(`Replaced draft ${draft.id} with ${draft.sourceHash}`, {
            action: "replace", draftId: draft.id, sourceHash: draft.sourceHash,
          });
        }
        if (params.source !== undefined || params.expectedDraftHash !== undefined) {
          throw new Error("workflow_draft validate accepts only action, namespace, and name");
        }
        const review = await drafts.validate(selector, ctx);
        const renderedReview = {
          ...review,
          sourceDiff: {
            ...review.sourceDiff,
            preview: review.sourceDiff.preview
              ? `[${Buffer.byteLength(review.sourceDiff.preview)}-byte diff available to the human promotion command]`
              : "",
          },
        };
        const rendered = `${review.valid ? "Valid" : "Invalid"} draft ${review.draftId} · review ${review.reviewHash}\n${stableJson(renderedReview)}`;
        const bounded = truncateBytes(rendered, 48 * 1024, "\n[… validation text truncated; use /flow validate for the bounded full review …]");
        return result(
          bounded,
          { action: "validate", draftId: review.draftId, sourceHash: review.sourceHash, review },
        );
      });
    },
  });
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}
