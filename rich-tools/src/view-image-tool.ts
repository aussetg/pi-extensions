import {
  createReadToolDefinition,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const VIEW_IMAGE_PARAMS = Type.Object(
  {
    path: Type.String({ description: "Path to the image file to view (png, jpg, jpeg, gif, or webp)" }),
  },
  { additionalProperties: false },
);

export function registerViewImageTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "view_image",
    label: "view_image",
    description: "View an image file. Supports png, jpg, jpeg, gif, and webp images.",
    promptSnippet: "View an image file",
    promptGuidelines: ["Use view_image when you need to inspect an image file."],
    parameters: VIEW_IMAGE_PARAMS,

    async execute(
      toolCallId: string,
      params: { path: string },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) {
      const imagePath = typeof params.path === "string" ? params.path : "";
      const extension = path.extname(imagePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        throw new Error("view_image only supports image files with .png, .jpg, .jpeg, .gif, or .webp extensions.");
      }

      const read = createReadToolDefinition(ctx.cwd);
      return read.execute(
        toolCallId,
        { path: imagePath },
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}
