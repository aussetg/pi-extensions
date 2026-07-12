import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolProfilePolicy, usesOpenAIToolProfile } from "./policy.ts";
import { registerApplyPatchTool } from "./tool.ts";
import { registerViewImageTool } from "./view-image-tool.ts";

export function registerToolProfileTools(pi: ExtensionAPI): void {
  const policy = createToolProfilePolicy(pi);

  registerApplyPatchTool(pi);
  registerViewImageTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    policy.captureBaseline();
    policy.apply(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    policy.apply(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    policy.apply(ctx);
    if (!usesOpenAIToolProfile(ctx)) return;

    const activeTools = new Set(pi.getActiveTools());
    const lines = [
      "\n\n# OpenAI tool profile",
      "- The file convenience tools read/edit/write/grep/find/ls are intentionally hidden for this model family.",
    ];

    if (activeTools.has("bash")) {
      lines.push("- Use bash for repository inspection: ls, find, rg, sed, git, and test commands.");
    }

    if (activeTools.has("view_image")) {
      lines.push("- Use view_image to inspect image files.");
    }

    if (activeTools.has("apply_patch")) {
      lines.push(
        "- Use apply_patch for file edits.",
        "- Use exactly one of these two forms for file edits.",
        "- Patch envelope form: set patch to a complete patch string with *** Begin Patch, one or more *** Add/Update/Delete File sections, and *** End Patch.",
        "- Structured JSON form: set operations to an array of create_file | update_file | delete_file objects.",
        "- In structured JSON form, diff contains only the file section body, not the full envelope.",
        "- Structured create_file diff: Add File body; every content line starts with '+'.",
        "- Structured update_file diff: Update File hunks; each non-empty diff line starts with @@, space, +, or -.",
        "- Do not include *** Begin Patch, *** End Patch, or *** Add/Update/Delete File lines inside operations[].diff; if you want those markers, use patch instead.",
        "- Structured delete_file: no diff.",
        "- Use create_file for new files and update_file for existing files.",
      );
    }

    return {
      systemPrompt: `${event.systemPrompt}${lines.join("\n")}\n`,
    };
  });
}
