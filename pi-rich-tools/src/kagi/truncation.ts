/** Per-page/global output limits and durable full-output persistence. */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LimitedMarkdown {
  markdown: string;
  originalCharacters: number;
  truncated: boolean;
}

export interface TruncatedToolOutput {
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  fullOutputReason?: string;
}

export function limitMarkdown(markdown: string, maxCharacters: number): LimitedMarkdown {
  if (markdown.length <= maxCharacters) {
    return { markdown, originalCharacters: markdown.length, truncated: false };
  }
  return {
    markdown: `${markdown.slice(0, maxCharacters).trimEnd()}\n\n[Page content truncated to ${maxCharacters} characters before global tool truncation.]`,
    originalCharacters: markdown.length,
    truncated: true,
  };
}

export async function truncateToolOutput(
  text: string,
  tempPrefix: string,
  filename: string,
  options: { fullText?: string; forceSaveFullOutput?: boolean; saveReason?: string } = {},
): Promise<TruncatedToolOutput> {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const fullText = options.fullText ?? text;
  const forceSaveFullOutput = options.forceSaveFullOutput === true && fullText !== text;
  if (!truncation.truncated && !forceSaveFullOutput) return { text };

  const tempDir = await mkdtemp(join(tmpdir(), tempPrefix));
  const fullOutputPath = join(tempDir, filename);
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, fullText, "utf8"));

  let truncatedText = truncation.truncated ? truncation.content : text;
  if (truncation.truncated) {
    truncatedText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    truncatedText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    truncatedText += ` Full output saved to: ${fullOutputPath}]`;
  } else {
    truncatedText += `\n\n[Full extracted content saved to: ${fullOutputPath}`;
    if (options.saveReason) truncatedText += ` (${options.saveReason})`;
    truncatedText += "]";
  }

  return {
    text: truncatedText,
    truncation: truncation.truncated ? truncation : undefined,
    fullOutputPath,
    fullOutputReason: truncation.truncated ? "tool-result-truncated" : options.saveReason,
  };
}
