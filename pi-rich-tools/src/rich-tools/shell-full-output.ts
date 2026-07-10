import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import {
  cleanShellPtyArtifacts,
  safeBashModelText,
} from "./bash-model-output.ts";
import { stripAnsiEscapes } from "./shell-ansi.ts";
import { isRecord } from "./util.ts";

const SHELL_CLEANING_CARRY_BYTES = 16 * 1024;
const POSSIBLY_DIRTY_SHELL_TEXT = /[\x00-\x08\x0b-\x1f\x7f\ufffd]/;

export type ShellFullOutputCleanupResult =
  | "unchanged"
  | "reflink"
  | "rewrite"
  | "failed";

type CleanedChunk = {
  rawBytes: Buffer;
  rawText: string;
};

export async function cleanShellFullOutputFile(details: unknown): Promise<void> {
  if (!isRecord(details) || typeof details.fullOutputPath !== "string") return;
  await cleanShellFullOutputFilePath(details.fullOutputPath);
}

/**
 * Clean a completed Bash output file without rewriting the common, already
 * clean case. On Btrfs, the first dirty chunk creates a reflink and only the
 * suffix from that chunk onward is rewritten; the untouched prefix remains
 * shared CoW data. Other filesystems fall back to a conventional atomic
 * rewrite only after dirtiness has been established.
 */
export async function cleanShellFullOutputFilePath(
  outputPath: string,
): Promise<ShellFullOutputCleanupResult> {
  const tempBase = `${outputPath}.pi-rich-tools-cleaning-${process.pid}-${randomUUID()}`;

  try {
    const reflinkResult = await cleanWithReflink(outputPath, `${tempBase}-reflink`);
    if (reflinkResult !== "rewrite") return reflinkResult;

    await rewriteCleanedFile(outputPath, `${tempBase}-rewrite`);
    return "rewrite";
  } catch {
    await Promise.all([
      rm(`${tempBase}-reflink`, { force: true }).catch(() => {}),
      rm(`${tempBase}-rewrite`, { force: true }).catch(() => {}),
    ]);
    // Best effort. The in-memory tool result is still stripped for model context.
    return "failed";
  }
}

export function contextShellText(rawText: string): string {
  return safeBashModelText(
    stripAnsiEscapes(cleanShellPtyArtifacts(rawText))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n"),
  );
}

async function cleanWithReflink(
  outputPath: string,
  tempPath: string,
): Promise<"unchanged" | "reflink" | "rewrite"> {
  let target: FileHandle | undefined;
  let targetOffset = 0;
  let firstChunk = true;
  let renamed = false;

  try {
    for await (const chunk of cleanedSourceChunks(outputPath)) {
      const cleaned = cleanChunk(chunk.rawText, firstChunk);
      firstChunk = false;

      if (!target && cleaned === chunk.rawText) {
        // Before the first change, target offsets are source byte offsets. Use
        // raw byte lengths so malformed UTF-8 in binary output stays aligned.
        targetOffset += chunk.rawBytes.length;
        continue;
      }

      if (!target) {
        target = await openReflink(outputPath, tempPath);
        if (!target) return "rewrite";
      }

      targetOffset += await writeText(target, cleaned, targetOffset);
    }

    if (!target) return "unchanged";
    await target.truncate(targetOffset);
    await target.close();
    target = undefined;
    await rename(tempPath, outputPath);
    renamed = true;
    return "reflink";
  } finally {
    await target?.close().catch(() => {});
    if (!renamed) await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function openReflink(
  outputPath: string,
  tempPath: string,
): Promise<FileHandle | undefined> {
  try {
    await copyFile(outputPath, tempPath, constants.COPYFILE_FICLONE_FORCE);
    return await open(tempPath, "r+");
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    return undefined;
  }
}

async function rewriteCleanedFile(
  outputPath: string,
  tempPath: string,
): Promise<void> {
  let target: FileHandle | undefined;
  let targetOffset = 0;
  let firstChunk = true;
  let renamed = false;

  try {
    target = await open(tempPath, "wx");
    for await (const chunk of cleanedSourceChunks(outputPath)) {
      const cleaned = cleanChunk(chunk.rawText, firstChunk);
      firstChunk = false;
      targetOffset += await writeText(target, cleaned, targetOffset);
    }

    await target.close();
    target = undefined;
    await rename(tempPath, outputPath);
    renamed = true;
  } finally {
    await target?.close().catch(() => {});
    if (!renamed) await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function* cleanedSourceChunks(outputPath: string): AsyncGenerator<CleanedChunk> {
  const source = createReadStream(outputPath);
  let carry = Buffer.alloc(0);

  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const text = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let emitLength = Math.max(0, text.length - SHELL_CLEANING_CARRY_BYTES);
      emitLength = utf8BoundaryAtOrBefore(text, emitLength);
      if (emitLength > 0 && text[emitLength - 1] === 0x0d) emitLength -= 1;

      if (emitLength === 0) {
        carry = text;
        continue;
      }

      const rawBytes = text.subarray(0, emitLength);
      carry = Buffer.from(text.subarray(emitLength));
      yield { rawBytes, rawText: rawBytes.toString("utf8") };
    }

    if (carry.length > 0) {
      yield { rawBytes: carry, rawText: carry.toString("utf8") };
    }
  } finally {
    source.destroy();
  }
}

function cleanChunk(rawText: string, firstChunk: boolean): string {
  if (
    !POSSIBLY_DIRTY_SHELL_TEXT.test(rawText) &&
    !(firstChunk && rawText.startsWith("^@"))
  ) {
    return rawText;
  }
  return contextShellText(rawText);
}

function utf8BoundaryAtOrBefore(buffer: Buffer, index: number): number {
  while (
    index > 0 &&
    index < buffer.length &&
    (buffer[index]! & 0xc0) === 0x80
  ) {
    index -= 1;
  }
  return index;
}

async function writeText(
  target: FileHandle,
  text: string,
  position: number,
): Promise<number> {
  const data = Buffer.from(text, "utf8");
  let written = 0;
  while (written < data.length) {
    const result = await target.write(
      data,
      written,
      data.length - written,
      position + written,
    );
    if (result.bytesWritten === 0) throw new Error("Could not write cleaned Bash output");
    written += result.bytesWritten;
  }
  return written;
}
