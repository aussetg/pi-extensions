import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  MAX_DIFF_INPUT_BYTES,
  buildPierreCreatePayload,
  buildPierreNumberedDiffPayload,
  buildPierreUpdatePayload,
  normalizeDiffMetadataLanguage,
  type PierreDiffPayload,
} from "../pierre/index.ts";
import {
  ByteLruCache,
  byteLength,
  hashTextParts,
  normalizeLineEndings,
  toFsPath,
} from "./util.ts";

const GLOBAL_STATE_KEY = "__piRichToolRenderersPayloadState";
const PAYLOAD_CACHE_MAX_ENTRIES = 192;
const PAYLOAD_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const WRITE_SNAPSHOT_MAX_ENTRIES = 96;
const WRITE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

type CachedPayload = PierreDiffPayload | null;

interface WriteSnapshot {
  displayPath: string;
  fsPath: string;
  existed: boolean;
  beforeContent?: string;
  beforeBytes: number;
  skippedReason?: string;
}

interface PayloadState {
  payloads: ByteLruCache<CachedPayload>;
  writeSnapshots: ByteLruCache<WriteSnapshot>;
}

export interface WritePreviewInfo {
  payload?: PierreDiffPayload;
  skippedReason?: string;
  existed?: boolean;
  collapsed?: {
    remaining: number;
    totalLines: number;
  };
}

function state(): PayloadState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: PayloadState;
  };
  scope[GLOBAL_STATE_KEY] ??= {
    payloads: new ByteLruCache<CachedPayload>({
      maxEntries: PAYLOAD_CACHE_MAX_ENTRIES,
      maxBytes: PAYLOAD_CACHE_MAX_BYTES,
    }),
    writeSnapshots: new ByteLruCache<WriteSnapshot>({
      maxEntries: WRITE_SNAPSHOT_MAX_ENTRIES,
      maxBytes: WRITE_SNAPSHOT_MAX_BYTES,
    }),
  };
  return scope[GLOBAL_STATE_KEY];
}

export function resetRichToolPayloadState(): void {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: PayloadState;
  };
  delete scope[GLOBAL_STATE_KEY];
}

export async function captureWriteSnapshot(options: {
  toolCallId: string;
  cwd?: string;
  path: string;
  nextContent: string;
}): Promise<void> {
  const fsPath = toFsPath(options.cwd, options.path);
  const nextBytes = byteLength(options.nextContent);
  const existed = existsSync(fsPath);
  const snapshot: WriteSnapshot = {
    displayPath: options.path,
    fsPath,
    existed,
    beforeBytes: 0,
  };

  if (existed) {
    if (nextBytes > MAX_DIFF_INPUT_BYTES) {
      snapshot.skippedReason = "new content too large for preview";
    } else {
      try {
        const size = statSync(fsPath).size;
        if (size + nextBytes > MAX_DIFF_INPUT_BYTES) {
          snapshot.beforeBytes = size;
          snapshot.skippedReason = "previous content too large for preview";
        } else {
          const before = await readFile(fsPath, "utf8");
          snapshot.beforeContent = before;
          snapshot.beforeBytes = byteLength(before);
        }
      } catch (error) {
        snapshot.skippedReason = error instanceof Error ? error.message : String(error);
      }
    }
  } else if (nextBytes > MAX_DIFF_INPUT_BYTES) {
    snapshot.skippedReason = "content too large for preview";
  }

  const bytes = snapshot.beforeContent === undefined ? 128 : snapshot.beforeBytes + 128;
  state().writeSnapshots.set(options.toolCallId, snapshot, bytes);
}

export function writePreviewPayload(options: {
  toolCallId?: string;
  path: string;
  content: string;
  maxDisplayLines?: number;
}): WritePreviewInfo {
  if (!options.toolCallId) return {};
  const snapshot = state().writeSnapshots.get(options.toolCallId);
  if (!snapshot) return {};

  const canShowCollapsedLargeCreate =
    snapshot.skippedReason === "content too large for preview" &&
    !snapshot.existed &&
    options.maxDisplayLines !== undefined;
  if (snapshot.skippedReason && !canShowCollapsedLargeCreate) {
    return { skippedReason: snapshot.skippedReason, existed: snapshot.existed };
  }

  const createPreview = !snapshot.existed && options.maxDisplayLines !== undefined
    ? collapseDisplayContent(options.content, options.maxDisplayLines)
    : undefined;
  const contentForDiff = createPreview?.content ?? options.content;
  const contentBytes = byteLength(contentForDiff);
  if (contentBytes > MAX_DIFF_INPUT_BYTES) {
    return {
      skippedReason: "content too large for preview",
      existed: snapshot.existed,
    };
  }

  const displayPath = snapshot.displayPath || options.path;
  const key = snapshot.existed
    ? cacheKey("write:update", displayPath, snapshot.beforeContent ?? "", options.content)
    : cacheKey(
        "write:create",
        displayPath,
        createPreview ? `max:${options.maxDisplayLines}` : "full",
        contentForDiff,
      );
  const cached = state().payloads.get(key);
  if (cached !== undefined) {
    return {
      payload: cached ?? undefined,
      existed: snapshot.existed,
      collapsed: createPreview?.collapsed,
    };
  }

  let payload: PierreDiffPayload | undefined;
  if (snapshot.existed) {
    if (snapshot.beforeContent === undefined) {
      return { skippedReason: "previous content unavailable", existed: true };
    }
    payload = buildPierreUpdatePayload({
      oldPath: displayPath,
      newPath: displayPath,
      oldContent: snapshot.beforeContent,
      newContent: options.content,
    });
  } else {
    payload = buildPierreCreatePayload({
      path: displayPath,
      newContent: contentForDiff,
    });
  }

  const payloadBytes = snapshot.beforeBytes + contentBytes + 128;
  state().payloads.set(key, payload ?? null, payloadBytes);
  return { payload, existed: snapshot.existed, collapsed: createPreview?.collapsed };
}

export function editPreviewPayload(options: {
  path: string;
  diff: string;
}): PierreDiffPayload | undefined {
  const diffBytes = byteLength(options.diff);
  if (diffBytes > MAX_DIFF_INPUT_BYTES) return undefined;

  const key = cacheKey("edit", options.path, options.diff);
  const cached = state().payloads.get(key);
  if (cached !== undefined) return cached ?? undefined;

  const payload = buildPierreNumberedDiffPayload({
    path: options.path,
    diff: options.diff,
  });
  state().payloads.set(key, payload ?? null, diffBytes + 128);
  return payload;
}

export function readPreviewPayload(options: {
  path: string;
  content: string;
  startLine: number;
}): PierreDiffPayload | undefined {
  const normalized = normalizeLineEndings(options.content);
  const contentBytes = byteLength(normalized);
  if (contentBytes > MAX_DIFF_INPUT_BYTES) return undefined;

  const key = cacheKey("read", options.path, String(options.startLine), normalized);
  const cached = state().payloads.get(key);
  if (cached !== undefined) return cached ?? undefined;

  const payload = buildContextOnlyPayload({
    path: options.path,
    content: normalized,
    startLine: options.startLine,
    cacheKey: key,
  });
  state().payloads.set(key, payload ?? null, contentBytes + 128);
  return payload;
}

function buildContextOnlyPayload(options: {
  path: string;
  content: string;
  startLine: number;
  cacheKey: string;
}): PierreDiffPayload | undefined {
  const lines = splitContentLines(options.content);
  const lineCount = Math.max(1, lines.length);
  const startLine = Math.max(1, Math.trunc(options.startLine) || 1);

  const hunk: FileDiffMetadata["hunks"][number] = {
    collapsedBefore: 0,
    additionStart: startLine,
    additionCount: lineCount,
    additionLines: 0,
    additionLineIndex: 0,
    deletionStart: startLine,
    deletionCount: lineCount,
    deletionLines: 0,
    deletionLineIndex: 0,
    hunkContent: [
      {
        type: "context",
        lines: lineCount,
        additionLineIndex: 0,
        deletionLineIndex: 0,
      },
    ],
    hunkSpecs: `@@ -${startLine},${lineCount} +${startLine},${lineCount} @@`,
    splitLineStart: 0,
    splitLineCount: lineCount,
    unifiedLineStart: 0,
    unifiedLineCount: lineCount,
    noEOFCRDeletions: false,
    noEOFCRAdditions: false,
  };

  const metadata: FileDiffMetadata = {
    name: options.path,
    type: "change",
    hunks: [hunk],
    splitLineCount: lineCount,
    unifiedLineCount: lineCount,
    isPartial: true,
    deletionLines: lines,
    additionLines: lines,
    cacheKey: options.cacheKey,
  };

  return {
    path: options.path,
    metadata: normalizeDiffMetadataLanguage(metadata, options.path),
  };
}

function cacheKey(prefix: string, ...parts: string[]): string {
  return `pi-rich:${prefix}:${hashTextParts(parts)}`;
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [""];
  const displayContent = content.endsWith("\n") ? content.slice(0, -1) : content;
  return displayContent.split("\n");
}

function collapseDisplayContent(
  content: string,
  maxDisplayLines: number,
): { content: string; collapsed?: { remaining: number; totalLines: number } } {
  const maxLines = Math.max(0, Math.trunc(maxDisplayLines));
  const lines = trimTrailingEmptyLines(normalizeLineEndings(content).split("\n"));
  if (lines.length <= maxLines) return { content };

  return {
    content: `${lines.slice(0, maxLines).join("\n")}\n`,
    collapsed: {
      remaining: lines.length - maxLines,
      totalLines: lines.length,
    },
  };
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}
