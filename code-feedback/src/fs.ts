import * as fs from "node:fs";

export const DEFAULT_TRACKED_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LSP_SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;

export type ReadUtf8SkippedReason = "missing" | "not-file" | "too-large" | "binary" | "read-error";

export interface ReadUtf8Result {
  content?: string;
  size?: number;
  skippedReason?: ReadUtf8SkippedReason;
  limitBytes?: number;
}

export function statIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

export function realpathIfExists(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

export function readDescriptorUpTo(descriptor: number, maxBytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function readUtf8IfExists(filePath: string): string | undefined {
  return readUtf8File(filePath).content;
}

export function readUtf8IfSmall(filePath: string, maxBytes = DEFAULT_TRACKED_FILE_MAX_BYTES): ReadUtf8Result {
  return readUtf8File(filePath, maxBytes);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${formatByteNumber(kib)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatByteNumber(mib)} MiB`;
  return `${formatByteNumber(mib / 1024)} GiB`;
}

function readUtf8File(filePath: string, maxBytes?: number): ReadUtf8Result {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { skippedReason: "not-file", size: stat.size, limitBytes: maxBytes };
    if (maxBytes !== undefined && stat.size > maxBytes) {
      return { skippedReason: "too-large", size: stat.size, limitBytes: maxBytes };
    }
    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("\0")) return { skippedReason: "binary", size: stat.size, limitBytes: maxBytes };
    return { content, size: stat.size, limitBytes: maxBytes };
  } catch {
    return fs.existsSync(filePath)
      ? { skippedReason: "read-error", limitBytes: maxBytes }
      : { skippedReason: "missing", limitBytes: maxBytes };
  }
}

function formatByteNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

