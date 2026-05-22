import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyOperations, prepareApplyTasks, withMutationQueues } from "./apply.ts";
import {
  prepareApplyPatchArguments,
  takePreparedApplyPatchWarnings,
} from "./codex-envelope.ts";
import { createThrottledProgressEmitter } from "./progress.ts";
import { collectProgressPreview, collectSuccessPreviews, renderApplyPatchCall, renderApplyPatchResult } from "./render.ts";
import type { ApplyPatchDetails, ApplyPatchOperation } from "./types.ts";
import { DiffError, shortenPathForDisplay } from "./util.ts";

export function registerApplyPatchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply file edits via JSON operations (create_file/update_file/delete_file) whose diff fields contain Codex apply_patch section bodies, not full envelopes. For update_file, each non-empty diff line must start with @@, space, +, or -. Never include envelope lines starting with *** in diff.",
    parameters: Type.Object(
      {
        operations: Type.Array(
          Type.Object(
            {
              type: StringEnum([
                "create_file",
                "update_file",
                "delete_file",
              ] as const),
              path: Type.String(),
              diff: Type.Optional(Type.String()),
              move_path: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    prepareArguments: prepareApplyPatchArguments,
    renderShell: "self",

    renderCall(args, theme, context) {
      return renderApplyPatchCall(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      return renderApplyPatchResult(result, options, theme, context);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const update = onUpdate as
        | AgentToolUpdateCallback<ApplyPatchDetails>
        | undefined;
      const progressEmitter = createThrottledProgressEmitter(update, 40);

      const ops = params.operations as ApplyPatchOperation[];
      if (ops.length === 0) {
        throw new DiffError("apply_patch requires at least one operation.");
      }
      const preparedWarnings = takePreparedApplyPatchWarnings(params);

      const queueTasks = prepareApplyTasks(ops, ctx.cwd).tasks;
      const queuePaths = queueTasks.flatMap((task) => task.touchedPaths);
      const preview = collectProgressPreview(ops);
      progressEmitter.emit("Applying patch operations...", preview, true);
      const { fuzz, results, warnings: applyWarnings } = await (async () => {
        try {
          return await withMutationQueues(
            queuePaths,
            () =>
              applyOperations(
                ops,
                ctx.cwd,
                signal,
                (msg, stepPreview) => progressEmitter.emit(msg, stepPreview),
              ),
          );
        } finally {
          progressEmitter.flush();
        }
      })();
      const warnings = [...preparedWarnings, ...applyWarnings];

      const failed = results.filter((r) => r.status === "failed");
      const warningText = warnings.length > 0 ? warnings.join("\n") : undefined;
      const summaryLines = results
        .map((r) => {
          const opName =
            r.type === "create_file"
              ? "create"
              : r.type === "update_file"
                ? "update"
                : "delete";
          const status = r.status === "completed" ? "✓" : "✗";
          return `${status} ${opName} ${shortenPathForDisplay(r.path)}${r.output ? ` — ${r.output}` : ""}`;
        })
        .join("\n");

      if (failed.length > 0) {
        const completedCount = results.filter((r) => r.status === "completed").length;
        const baseError = summaryLines
          ? `${completedCount > 0 ? "Patch partially applied:" : "Patch was not applied:"}\n${summaryLines}`
          : `${failed.length} operation(s) failed`;
        throw new DiffError(
          warningText
            ? `${warningText}\n${baseError}`
            : baseError,
        );
      }

      const previews = collectSuccessPreviews(results);
      const contentText = warningText
        ? `${summaryLines || "✓"}\n${warningText}`
        : summaryLines || "✓";

      return {
        content: [{ type: "text", text: contentText }],
        details: { stage: "done", fuzz, results, previews, warnings },
      };
    },
  });
}
