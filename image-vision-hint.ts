import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete, type Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Extension for handling images with non-vision models.
 *
 * When the current model doesn't support vision:
 * 1. Activates the `read_image` tool (deactivates it when vision is available)
 * 2. Intercepts `read` tool results containing images and tells the model to use `read_image`
 *
 * Configuration via ~/.pi/agent/vision-config.json:
 * {
 *   "model": "glm-4.6v",        // Vision model ID to use
 *   "provider": "zai"           // Provider (optional, inferred from model)
 * }
 */

interface VisionConfig {
  model?: string;
  provider?: string;
}

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface ReadImageDetails {
  visionModel: string;
  visionProvider: string;
  imagePath: string;
  prompt: string;
}

const TOOL_NAME = "read_image";
const CONFIG_FILE = "~/.pi/agent/vision-config.json";

function loadConfig(): VisionConfig {
  try {
    const configPath = CONFIG_FILE.replace("~", process.env.HOME || "");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    // Ignore errors, fall back to defaults
  }
  return {};
}

async function findVisionModel(ctx: ExtensionContext): Promise<{ provider: string; model: string } | null> {
  // Load config from file
  const config = loadConfig();

  // getAvailable() returns Model[] directly, each model has a provider property
  const available = ctx.modelRegistry.getAvailable();

  if (config.model) {
    // Find the model in the registry
    const found = available.find((m) => m.id === config.model && m.input.includes("image"));
    if (found) {
      return { provider: config.provider ?? found.provider, model: found.id };
    }
    // Fall through to auto-detect if config model not found
  }

  // Find first available vision model (prefer glm-4.6v, then faster/cheaper models)
  const preferredPatterns = ["glm-4.6v", "claude-3-5-haiku", "gpt-4o-mini", "gemini-2.0-flash", "haiku", "flash"];
  for (const pattern of preferredPatterns) {
    const found = available.find((m) => m.id.includes(pattern) && m.input.includes("image"));
    if (found) {
      return { provider: found.provider, model: found.id };
    }
  }

  // Fall back to any vision model
  const anyVision = available.find((m) => m.input.includes("image"));
  if (anyVision) {
    return { provider: anyVision.provider, model: anyVision.id };
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  // Register the tool once at startup
  pi.registerTool({
    name: TOOL_NAME,
    label: "Read Image",
    description:
      "Analyze an image file using a vision-capable model. Use this when you need to understand, describe, or answer questions about an image.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file (relative or absolute)" }),
      prompt: Type.String({
        description: 'What you want to know about the image, e.g., "Describe this image" or "What text is shown?"',
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const visionConfig = await findVisionModel(ctx);

      if (!visionConfig) {
        return {
          content: [
            {
              type: "text",
              text: "No vision-capable model available. Configure a vision model in ~/.pi/agent/vision-config.json or switch to a model that supports images using /model.",
            },
          ],
          details: {
            visionModel: "none",
            visionProvider: "none",
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }

      const { provider, model: visionModelId } = visionConfig;
      const model = ctx.modelRegistry.find(provider, visionModelId);

      if (!model) {
        return {
          content: [{ type: "text", text: `Vision model ${provider}/${visionModelId} not found in registry.` }],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }

      // Resolve path
      const imagePath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const absolutePath = imagePath.startsWith("/") ? imagePath : path.join(ctx.cwd, imagePath);

      // Check file exists
      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `Image file not found: ${params.path}` }],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }

      // Read and encode image
      let imageBuffer: Buffer;
      let mimeType: string;

      try {
        imageBuffer = fs.readFileSync(absolutePath);
        const ext = path.extname(absolutePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        };
        mimeType = mimeTypes[ext] || "image/png";
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to read image: ${err}` }],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }

      // Get API key
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: `No API key available for vision model ${provider}/${visionModelId}. Run /login or set the appropriate environment variable.`,
            },
          ],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }

      // Build message for vision model
      const userMessage: Message = {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          {
            type: "image",
            data: imageBuffer.toString("base64"),
            mimeType: mimeType,
          },
        ],
        timestamp: Date.now(),
      };

      // Call vision model
      try {
        const response = await complete(model, { messages: [userMessage] }, { apiKey, signal });

        if (response.stopReason === "aborted") {
          return {
            content: [{ type: "text", text: "Image analysis was cancelled." }],
            details: {
              visionModel: visionModelId,
              visionProvider: provider,
              imagePath: params.path,
              prompt: params.prompt,
            } as ReadImageDetails,
          };
        }

        // Handle error stop reason
        if (response.stopReason === "error") {
          const errorMsg = response.errorMessage || "Unknown error from vision model";
          return {
            content: [{ type: "text", text: `Vision model error: ${errorMsg}` }],
            details: {
              visionModel: visionModelId,
              visionProvider: provider,
              imagePath: params.path,
              prompt: params.prompt,
            } as ReadImageDetails,
            isError: true,
          };
        }

        // Extract text response
        const textContent = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        return {
          content: [{ type: "text", text: textContent || "(no response from vision model)" }],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Vision model error: ${errorMsg}` }],
          details: {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          } as ReadImageDetails,
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const pathPreview = args.path.length > 50 ? `...${args.path.slice(-47)}` : args.path;
      const promptPreview = args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}...` : args.prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("read_image ")) +
          theme.fg("accent", pathPreview) +
          "\n  " +
          theme.fg("dim", promptPreview),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ReadImageDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

      if (result.isError) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("toolOutput", text), 0, 0);
      }

      if (expanded) {
        const via = details ? ` (via ${details.visionProvider}/${details.visionModel})` : "";
        return new Text(theme.fg("success", "✓") + theme.fg("muted", via) + "\n\n" + theme.fg("toolOutput", text), 0, 0);
      }

      // Collapsed view
      const lines = text.split("\n");
      const preview = lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n..." : "");
      const via = details ? ` ${theme.fg("muted", `(${details.visionProvider}/${details.visionModel})`)}` : "";
      return new Text(theme.fg("success", "✓") + via + "\n" + theme.fg("toolOutput", preview), 0, 0);
    },
  });

  // Track current vision support state
  let toolActivated = false;

  // Helper to update tool activation based on model
  const updateToolActivation = (ctx: ExtensionContext, silent = false) => {
    const model = ctx.model;
    if (!model) return;

    const supportsVision = model.input.includes("image");
    const activeTools = pi.getActiveTools();
    const toolInActive = activeTools.includes(TOOL_NAME);

    if (!supportsVision && !toolInActive) {
      // Non-vision model and tool not active - activate it
      pi.setActiveTools([...activeTools, TOOL_NAME]);
      toolActivated = true;
      if (!silent) ctx.ui.notify("read_image tool enabled (non-vision model)", "info");
    } else if (supportsVision && toolInActive) {
      // Vision model and tool is active - deactivate it
      pi.setActiveTools(activeTools.filter((t) => t !== TOOL_NAME));
      toolActivated = false;
      if (!silent) ctx.ui.notify("read_image tool disabled (vision model active)", "info");
    }
  };

  // Check on session start
  pi.on("session_start", async (_event, ctx) => {
    updateToolActivation(ctx, true); // silent on startup
  });

  // Check when model changes
  pi.on("model_select", async (_event, ctx) => {
    updateToolActivation(ctx);
  });

  // Also check before each agent turn to ensure correct state
  pi.on("before_agent_start", async (_event, ctx) => {
    updateToolActivation(ctx, true);
  });

  // Intercept read tool results with images
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    // Only interested in read tool results
    if (event.toolName !== "read") return;

    // Check if result contains an image
    const hasImage = event.content.some((c) => c.type === "image");
    if (!hasImage) return;

    // Check if current model supports images
    const model = ctx.model;
    if (!model) return;

    const supportsImages = model.input.includes("image");
    if (supportsImages) return;

    // Model doesn't support images - tell the model to use read_image
    const imagePath = (event.input.path as string) || "the image file";

    // Remove image content and replace with instructions
    event.content = [
      {
        type: "text",
        text: `[The current model (${model.provider}/${model.id}) cannot view images. The image has been loaded but cannot be displayed to this model.\n\nTo analyze this image, use the read_image tool:\n\nread_image(path: "${imagePath}", prompt: "Your question about the image")\n\nThe read_image tool will use a vision-capable model to analyze the image and return the result to you.]`,
      },
    ];

    // Return the modified content
    return { content: event.content };
  });
}
