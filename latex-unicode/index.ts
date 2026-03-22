/**
 * LaTeX-to-Unicode renderer extension for pi.
 *
 * Mutates message content in-place so the TUI renders Unicode math symbols
 * directly, without duplicating messages. Optimized for PragmataPro Semiotics.
 *
 * Install: ~/.pi/agent/extensions/latex-unicode/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasLatex, latexToUnicode } from "./converter";

interface TextBlock {
  type: "text";
  text: string;
}

/** Mutate text blocks in a message's content array. */
function transformContent(content: unknown): boolean {
  let changed = false;

  if (typeof content === "string") {
    // User messages can be plain strings — but the object reference
    // on the message is what the TUI reads, so we'd need to replace
    // it on the parent. We handle that in the caller.
    return hasLatex(content);
  }

  if (!Array.isArray(content)) return false;

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      "text" in block
    ) {
      const tb = block as TextBlock;
      if (hasLatex(tb.text)) {
        tb.text = latexToUnicode(tb.text);
        changed = true;
      }
    }
  }

  return changed;
}

export default function (pi: ExtensionAPI) {
  // Mutate user + assistant messages in-place so the TUI renders Unicode.
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (msg.role !== "user" && msg.role !== "assistant") return;

    // Content is usually an array of blocks for assistant, or a string for user.
    const content = (msg as { content: unknown }).content;

    if (typeof content === "string") {
      if (hasLatex(content)) {
        (msg as { content: string }).content = latexToUnicode(content);
      }
      return;
    }

    transformContent(content);
  });
}
