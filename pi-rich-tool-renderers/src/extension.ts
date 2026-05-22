import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { reloadPierreRendererConfig } from "../../codex-apply-patch/src/pierre/config.ts";
import { captureWriteSnapshot } from "./payloads.ts";
import {
  renderEditCall,
  renderEditResult,
  renderReadCall,
  renderReadResult,
  renderWriteCall,
  renderWriteResult,
} from "./render.ts";
import { isRecord } from "./util.ts";

export function registerRichToolRenderers(pi: ExtensionAPI): void {
  reloadPierreRendererConfig();

  const cwd = process.cwd();
  registerReadRenderer(pi, cwd);
  registerWriteRenderer(pi, cwd);
  registerEditRenderer(pi, cwd);

  pi.on?.("session_start", async () => {
    reloadPierreRendererConfig();
  });
}

function registerReadRenderer(pi: ExtensionAPI, cwd: string): void {
  const original = createReadTool(cwd);
  pi.registerTool({
    ...original,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderReadCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderReadResult(result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return original.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

function registerWriteRenderer(pi: ExtensionAPI, cwd: string): void {
  const original = createWriteTool(cwd);
  pi.registerTool({
    ...original,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderWriteCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderWriteResult(result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (isWriteParams(params)) {
        await captureWriteSnapshot({
          toolCallId,
          cwd: ctx.cwd,
          path: params.path,
          nextContent: params.content,
        });
      }
      return original.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

function registerEditRenderer(pi: ExtensionAPI, cwd: string): void {
  const original = createEditTool(cwd);
  pi.registerTool({
    ...original,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderEditCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderEditResult(result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return original.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

function isWriteParams(value: unknown): value is { path: string; content: string } {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}
