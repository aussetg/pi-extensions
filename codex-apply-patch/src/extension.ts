import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
        "- Use the apply_patch tool for file edits.\n" +
        "- Use operations with type: create_file | update_file | delete_file.\n" +
        "- The diff field contains a Codex apply_patch section body, not a full *** Begin/End Patch envelope.\n" +
        "- For create_file: diff is an Add File body; every content line starts with '+'.\n" +
        "- For update_file: diff is an Update File body with @@ sections; each non-empty diff line must start with @@, space, +, or -.\n" +
        "- NEVER include Codex envelope marker lines starting with *** inside diff.\n" +
        "- BAD: *** End Patch\n" +
        "- GOOD: end diff after normal @@/context/add/remove lines.\n" +
        "- If you need literal *** text in file content, use +*** ... (or a context line starting with a single space).\n" +
        "- For delete_file: no diff.\n" +
        "- Use create_file for new files and update_file for existing files.\n",
    };
  });
}
