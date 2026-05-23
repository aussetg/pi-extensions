import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LSP_TOOL_MAX_BYTES = 50 * 1024;
export const LSP_TOOL_MAX_LINES = 2000;

export interface LspToolTruncation {
  truncated: true;
  maxBytes: number;
  maxLines: number;
  outputBytes: number;
  outputLines: number;
  totalBytes: number;
  totalLines: number;
  fullOutputPath: string;
}

export function limitLspToolText(text: string): { text: string; truncation?: LspToolTruncation } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const totalLines = countLines(text);
  if (totalBytes <= LSP_TOOL_MAX_BYTES && totalLines <= LSP_TOOL_MAX_LINES) {
    return { text };
  }

  const content = takeHeadByLinesAndBytes(text, LSP_TOOL_MAX_LINES, LSP_TOOL_MAX_BYTES);
  const fullOutputPath = writeTempOutput(text);
  const outputBytes = Buffer.byteLength(content, "utf8");
  const outputLines = countLines(content);
  const truncation: LspToolTruncation = {
    truncated: true,
    maxBytes: LSP_TOOL_MAX_BYTES,
    maxLines: LSP_TOOL_MAX_LINES,
    outputBytes,
    outputLines,
    totalBytes,
    totalLines,
    fullOutputPath,
  };

  return {
    text: `${content.trimEnd()}\n\n${formatTruncationNotice(truncation)}`,
    truncation,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function formatTruncationNotice(truncation: LspToolTruncation): string {
  return [
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `Full output saved to: ${truncation.fullOutputPath}]`,
  ].join(" ");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function takeHeadByLinesAndBytes(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (out.length >= maxLines) break;
    const suffix = out.length < lines.length - 1 ? "\n" : "";
    const candidate = `${line}${suffix}`;
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (bytes + candidateBytes > maxBytes) {
      const remaining = maxBytes - bytes;
      if (remaining > 0) out.push(takeUtf8Prefix(candidate, remaining));
      break;
    }
    out.push(candidate);
    bytes += candidateBytes;
  }

  return out.join("");
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function writeTempOutput(text: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-"));
  const tempFile = path.join(tempDir, "output.txt");
  fs.writeFileSync(tempFile, text, "utf8");
  return tempFile;
}
