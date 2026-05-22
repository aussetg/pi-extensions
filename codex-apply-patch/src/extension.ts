import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchToolPolicy, isCodexModel } from "./policy.ts";
import { reloadPierreRendererConfig } from "./pierre/config.ts";
import { registerApplyPatchTool } from "./tool.ts";

export function registerApplyPatchExtension(pi: ExtensionAPI): void {
  reloadPierreRendererConfig();

  const policy = createApplyPatchToolPolicy(pi);

  registerApplyPatchTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    reloadPierreRendererConfig();
    policy.captureBaseline();
    policy.apply(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    policy.apply(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    policy.apply(ctx);
    if (!isCodexModel(ctx)) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n# apply_patch\n" +
        "- Use exactly one of these two forms for file edits.\n" +
        "- Codex envelope form: set patch to a complete patch string with *** Begin Patch, one or more *** Add/Update/Delete File sections, and *** End Patch.\n" +
        "- Structured JSON form: set operations to an array of create_file | update_file | delete_file objects.\n" +
        "- In structured JSON form, diff contains only the Codex section body, not the full envelope.\n" +
        "- Structured create_file diff: Add File body; every content line starts with '+'.\n" +
        "- Structured update_file diff: Update File hunks; each non-empty diff line starts with @@, space, +, or -.\n" +
        "- Do not include *** Begin Patch, *** End Patch, or *** Add/Update/Delete File lines inside operations[].diff; if you want those markers, use patch instead.\n" +
        "- Structured delete_file: no diff.\n" +
        "- Use create_file for new files and update_file for existing files.\n",
    };
  });
}
