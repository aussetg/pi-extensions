#!/usr/bin/env node
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_SESSION_ROOT = path.join(homedir(), ".pi", "agent", "sessions");
const MAX_PERSISTED_CHANGE_BYTES = 1_000_000;

export function migrateJsonValue(value, stats = createStats()) {
  return migrateNode(value, stats);
}

export function createStats() {
  return {
    filesScanned: 0,
    filesChanged: 0,
    linesScanned: 0,
    linesChanged: 0,
    parseErrors: 0,
    detailsMigrated: 0,
    previewsRemoved: 0,
    resultPierreRemoved: 0,
    resultDiffRemoved: 0,
    changesAdded: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const targets = options.paths.length > 0 ? options.paths : [DEFAULT_SESSION_ROOT];
  const files = [];
  for (const target of targets) files.push(...await collectJsonlFiles(target));

  const totals = createStats();
  for (const file of files) {
    const stats = await migrateJsonlFile(file, options);
    mergeStats(totals, stats);
  }

  printSummary(totals, { write: options.write, files: files.length });
}

function parseArgs(argv) {
  const options = {
    write: false,
    backup: true,
    help: false,
    paths: [],
  };

  for (const arg of argv) {
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.write = false;
      continue;
    }
    if (arg === "--backup") {
      options.backup = true;
      continue;
    }
    if (arg === "--no-backup") {
      options.backup = false;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    options.paths.push(path.resolve(arg));
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-apply-patch-sessions.mjs [--write] [--no-backup] [path ...]

Cleanup old apply_patch session metadata.

Default path: ${DEFAULT_SESSION_ROOT}

By default this is a dry run. Pass --write to rewrite changed JSONL files.
When writing, a .bak copy is created next to each changed file unless --no-backup is passed.

What it does:
  - removes details.previews
  - removes results[].pierre
  - removes legacy results[].diff after converting it when possible
  - writes compact results[].change data for previews that can be reconstructed
`);
}

async function collectJsonlFiles(target) {
  const st = await stat(target).catch(() => undefined);
  if (!st) return [];
  if (st.isFile()) return target.endsWith(".jsonl") ? [target] : [];
  if (!st.isDirectory()) return [];

  const out = [];
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...await collectJsonlFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(child);
  }
  return out;
}

async function migrateJsonlFile(file, options) {
  const stats = createStats();
  stats.filesScanned = 1;

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const input = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const output = options.write ? createWriteStream(tmp, { encoding: "utf8" }) : undefined;
  let changed = false;

  try {
    for await (const line of rl) {
      stats.linesScanned += 1;
      const oldLine = `${line}\n`;
      stats.bytesBefore += Buffer.byteLength(oldLine, "utf8");

      let nextLine = oldLine;
      if (line.trim().length > 0) {
        try {
          const record = JSON.parse(line);
          if (migrateJsonValue(record, stats)) {
            nextLine = `${JSON.stringify(record)}\n`;
            changed = true;
            stats.linesChanged += 1;
          }
        } catch {
          stats.parseErrors += 1;
        }
      }

      stats.bytesAfter += Buffer.byteLength(nextLine, "utf8");
      if (output) {
        if (!output.write(nextLine)) await onceDrain(output);
      }
    }

    if (output) await closeWriteStream(output);

    if (!changed) {
      await unlink(tmp).catch(() => undefined);
      return stats;
    }

    stats.filesChanged = 1;
    if (options.write) {
      if (options.backup) await copyBackup(file);
      await rename(tmp, file);
    } else {
      await unlink(tmp).catch(() => undefined);
    }

    return stats;
  } catch (error) {
    output?.destroy();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("error", onError);
    stream.end(() => {
      cleanup();
      resolve();
    });
  });
}

async function copyBackup(file) {
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? `${file}.bak` : `${file}.bak.${index}`;
    try {
      await copyFile(file, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

function migrateNode(value, stats) {
  if (!value || typeof value !== "object") return false;

  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = migrateNode(item, stats) || changed;
    return changed;
  }

  if (isApplyPatchDoneDetails(value)) {
    changed = migrateApplyPatchDetails(value, stats) || changed;
  }

  for (const key of Object.keys(value)) {
    changed = migrateNode(value[key], stats) || changed;
  }

  return changed;
}

function isApplyPatchDoneDetails(value) {
  return (
    isRecord(value) &&
    value.stage === "done" &&
    Number.isFinite(value.fuzz) &&
    Array.isArray(value.results) &&
    value.results.some(isApplyPatchResultLike) &&
    hasLegacyApplyPatchMetadata(value)
  );
}

function hasLegacyApplyPatchMetadata(details) {
  return (
    "previews" in details ||
    details.results.some(
      (result) => isRecord(result) && ("pierre" in result || "diff" in result),
    )
  );
}

function isApplyPatchResultLike(value) {
  return (
    isRecord(value) &&
    (value.type === "create_file" ||
      value.type === "update_file" ||
      value.type === "delete_file") &&
    typeof value.path === "string" &&
    (value.status === "completed" || value.status === "failed")
  );
}

function migrateApplyPatchDetails(details, stats) {
  let changed = false;
  const previews = Array.isArray(details.previews)
    ? details.previews.filter(isRecord)
    : [];
  const previewsByPath = new Map();
  for (const preview of previews) {
    if (typeof preview.path === "string") {
      const queue = previewsByPath.get(preview.path);
      if (queue) queue.push(preview);
      else previewsByPath.set(preview.path, [preview]);
    }
  }

  for (const result of details.results) {
    if (!isApplyPatchResultLike(result)) continue;
    const preview = takePreview(previewsByPath, result.path);

    if (result.status === "completed" && !isApplyPatchChange(result.change)) {
      const change = buildChangeForResult(result, preview);
      if (change) {
        result.change = change;
        stats.changesAdded += 1;
        changed = true;
      }
    }

    if ("pierre" in result) {
      delete result.pierre;
      stats.resultPierreRemoved += 1;
      changed = true;
    }
    if ("diff" in result) {
      delete result.diff;
      stats.resultDiffRemoved += 1;
      changed = true;
    }
  }

  if ("previews" in details) {
    delete details.previews;
    stats.previewsRemoved += previews.length;
    changed = true;
  }

  if (changed) stats.detailsMigrated += 1;
  return changed;
}

function takePreview(previewsByPath, resultPath) {
  const queue = previewsByPath.get(resultPath);
  if (!queue || queue.length === 0) return undefined;
  return queue.shift();
}

function buildChangeForResult(result, preview) {
  if (result.type === "update_file") {
    const fromNumberedDiff = updateChangeFromNumberedDiff(result, preview);
    if (fromNumberedDiff) return fromNumberedDiff;
  }

  const pierre = isPierrePayload(result.pierre)
    ? result.pierre
    : isPierrePayload(preview?.pierre)
      ? preview.pierre
      : undefined;
  if (pierre) {
    const fromPierre = changeFromPierre(result, pierre);
    if (fromPierre) return fromPierre;
  }

  if (result.type !== "update_file") return undefined;
  return updateChangeFromNumberedDiff(result, preview);
}

function updateChangeFromNumberedDiff(result, preview) {
  const numberedDiff = typeof result.diff === "string"
    ? result.diff
    : typeof preview?.diff === "string"
      ? preview.diff
      : undefined;
  if (!numberedDiff) return undefined;

  const oldPath = movedFromPath(result.output) ?? result.path;
  const unifiedDiff = unifiedPatchFromNumberedDiff({
    oldPath,
    newPath: result.path,
    diff: numberedDiff,
  });
  if (!unifiedDiff) return undefined;
  return persistableChange({
    type: "update",
    unifiedDiff,
    ...(oldPath === result.path ? {} : { movePath: result.path }),
  });
}

function changeFromPierre(result, payload) {
  const metadata = payload.metadata;
  if (!isRecord(metadata)) return undefined;

  if (result.type === "create_file" || metadata.type === "new") {
    return persistableChange({
      type: "add",
      content: contentFromMetadataLines(metadata, "addition"),
    });
  }
  if (result.type === "delete_file" || metadata.type === "deleted") {
    return persistableChange({
      type: "delete",
      content: contentFromMetadataLines(metadata, "deletion"),
    });
  }
  if (result.type !== "update_file") return undefined;

  const oldPath = typeof metadata.prevName === "string"
    ? metadata.prevName
    : movedFromPath(result.output) ?? result.path;
  const newPath = result.path || payload.path || metadata.name || oldPath;
  const unifiedDiff = unifiedPatchFromPierreMetadata(metadata, oldPath, newPath);
  if (!unifiedDiff) return undefined;
  return persistableChange({
    type: "update",
    unifiedDiff,
    ...(oldPath === newPath ? {} : { movePath: newPath }),
  });
}

function persistableChange(change) {
  const bytes = Buffer.byteLength(changeBytesText(change), "utf8");
  return bytes <= MAX_PERSISTED_CHANGE_BYTES ? change : undefined;
}

function changeBytesText(change) {
  switch (change.type) {
    case "add":
    case "delete":
      return change.content;
    case "update":
      return change.unifiedDiff;
    default:
      return "";
  }
}

function contentFromMetadataLines(metadata, side) {
  const lines = side === "addition" ? metadata.additionLines : metadata.deletionLines;
  const noFinalNewline = metadataNoFinalNewline(metadata, side);
  return contentFromLines(lines, { finalNewline: !noFinalNewline });
}

function metadataNoFinalNewline(metadata, side) {
  const key = side === "addition" ? "noEOFCRAdditions" : "noEOFCRDeletions";
  return Array.isArray(metadata.hunks) && metadata.hunks.some((hunk) => hunk?.[key] === true);
}

function contentFromLines(value, options = { finalNewline: true }) {
  if (!Array.isArray(value) || value.length === 0) return "";
  const lines = value.map((line) => String(line ?? ""));
  if (lines.some((line) => /[\r\n]$/.test(line))) {
    const content = lines.join("");
    return options.finalNewline && !/[\r\n]$/.test(content) ? `${content}\n` : content;
  }

  const content = lines.join("\n");
  return options.finalNewline ? `${content}\n` : content;
}

function unifiedPatchFromPierreMetadata(metadata, oldPath, newPath) {
  const hunks = Array.isArray(metadata.hunks) ? metadata.hunks : [];
  const out = unifiedPatchHeader(oldPath, newPath);
  for (const hunk of hunks) {
    if (!isRecord(hunk) || !Array.isArray(hunk.hunkContent)) continue;
    out.push(
      `@@ -${numberOr(hunk.deletionStart, 0)},${numberOr(hunk.deletionCount, 0)} +${numberOr(hunk.additionStart, 0)},${numberOr(hunk.additionCount, 0)} @@`,
    );
    let deletionIndex = numberOr(hunk.deletionLineIndex, 0);
    let additionIndex = numberOr(hunk.additionLineIndex, 0);

    for (const part of hunk.hunkContent) {
      if (!isRecord(part)) continue;
      if (part.type === "context") {
        const count = numberOr(part.lines, 0);
        for (let i = 0; i < count; i += 1) {
          out.push(` ${diffLineContent(lineAt(metadata.additionLines, additionIndex + i) ?? lineAt(metadata.deletionLines, deletionIndex + i) ?? "")}`);
          pushNoNewlineMarkerIfNeeded(out, metadata, hunk, "deletion", deletionIndex + i);
          pushNoNewlineMarkerIfNeeded(out, metadata, hunk, "addition", additionIndex + i);
        }
        deletionIndex += count;
        additionIndex += count;
        continue;
      }
      if (part.type === "change") {
        const deletions = numberOr(part.deletions, 0);
        const additions = numberOr(part.additions, 0);
        for (let i = 0; i < deletions; i += 1) {
          out.push(`-${diffLineContent(lineAt(metadata.deletionLines, deletionIndex + i) ?? "")}`);
          pushNoNewlineMarkerIfNeeded(out, metadata, hunk, "deletion", deletionIndex + i);
        }
        for (let i = 0; i < additions; i += 1) {
          out.push(`+${diffLineContent(lineAt(metadata.additionLines, additionIndex + i) ?? "")}`);
          pushNoNewlineMarkerIfNeeded(out, metadata, hunk, "addition", additionIndex + i);
        }
        deletionIndex += deletions;
        additionIndex += additions;
      }
    }
  }
  return `${out.join("\n")}\n`;
}

function pushNoNewlineMarkerIfNeeded(out, metadata, hunk, side, index) {
  const lines = side === "addition" ? metadata.additionLines : metadata.deletionLines;
  const key = side === "addition" ? "noEOFCRAdditions" : "noEOFCRDeletions";
  if (hunk?.[key] === true && Array.isArray(lines) && index === lines.length - 1) {
    out.push("\\ No newline at end of file");
  }
}

function diffLineContent(value) {
  return String(value ?? "").replace(/\r\n$/, "").replace(/[\r\n]$/, "");
}

function lineAt(lines, index) {
  return Array.isArray(lines) && index >= 0 && index < lines.length
    ? String(lines[index] ?? "")
    : undefined;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function movedFromPath(output) {
  if (typeof output !== "string") return undefined;
  const match = /^Moved from (.+)$/.exec(output.trim());
  return match?.[1];
}

function isApplyPatchChange(value) {
  if (!isRecord(value)) return false;
  if (value.type === "add" || value.type === "delete") {
    return typeof value.content === "string";
  }
  return value.type === "update" && typeof value.unifiedDiff === "string";
}

function isPierrePayload(value) {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isRecord(value.metadata)
  );
}

function unifiedPatchFromNumberedDiff(options) {
  const normalizedDiff = normalizeLineEndings(options.diff);
  if (!normalizedDiff.trim()) {
    return options.oldPath === options.newPath
      ? undefined
      : `${unifiedPatchHeader(options.oldPath, options.newPath).join("\n")}\n`;
  }

  const parsed = [];
  for (const line of normalizedDiff.split("\n")) {
    if (line === "") continue;
    const parsedLine = parseNumberedDiffLine(line);
    if (!parsedLine) return undefined;
    parsed.push(parsedLine);
  }

  const hunks = [];
  let current = [];
  for (const line of parsed) {
    if (line.kind === "gap") {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current);

  const changedHunks = hunks.filter((hunk) =>
    hunk.some((line) => line.sign === "+" || line.sign === "-"),
  );
  if (changedHunks.length === 0) return undefined;

  const out = unifiedPatchHeader(options.oldPath, options.newPath);
  let deltaBefore = 0;
  for (const hunk of changedHunks) {
    const header = numberedDiffHunkHeader(hunk, deltaBefore);
    deltaBefore += header.newLines - header.oldLines;
    out.push(header.text);
    for (const line of hunk) out.push(`${line.sign}${line.content}`);
  }

  return `${out.join("\n")}\n`;
}

function unifiedPatchHeader(oldPath, newPath) {
  const oldSafe = sanitizePatchPath(oldPath);
  const newSafe = sanitizePatchPath(newPath);
  const out = [];
  if (oldSafe === newSafe) out.push(`Index: ${oldSafe}`);
  out.push("===================================================================");
  out.push(`--- ${oldSafe}`);
  out.push(`+++ ${newSafe}`);
  return out;
}

function parseNumberedDiffLine(line) {
  const sign = line[0];
  if (sign !== " " && sign !== "+" && sign !== "-") return undefined;

  const rest = line.slice(1);
  if (sign === " " && /^ +\.\.\.$/.test(rest)) return { kind: "gap" };

  const match = /^ *(\d+) (.*)$/.exec(rest);
  if (!match) return undefined;

  return {
    kind: "line",
    sign,
    lineNumber: Number.parseInt(match[1], 10),
    content: match[2] ?? "",
  };
}

function numberedDiffHunkHeader(hunk, deltaBefore) {
  const oldLines = hunk.filter((line) => line.sign !== "+");
  const newLines = hunk.filter((line) => line.sign !== "-");
  const oldStart = oldHunkStart(oldLines, newLines, deltaBefore);
  const newStart = newHunkStart(hunk, oldStart, deltaBefore, newLines.length);
  return {
    text: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    oldLines: oldLines.length,
    newLines: newLines.length,
  };
}

function oldHunkStart(oldLines, newLines, deltaBefore) {
  const firstOld = oldLines[0]?.lineNumber;
  if (typeof firstOld === "number") return firstOld;

  const firstNew = newLines[0]?.lineNumber;
  if (typeof firstNew === "number") return Math.max(0, firstNew - deltaBefore - 1);

  return 0;
}

function newHunkStart(hunk, oldStart, deltaBefore, newLineCount) {
  if (newLineCount === 0) return Math.max(0, oldStart + deltaBefore - 1);

  const firstLine = hunk[0];
  if (firstLine?.sign === "+") return firstLine.lineNumber;

  return Math.max(0, oldStart + deltaBefore);
}

function normalizeLineEndings(text) {
  return text.includes("\r") ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : text;
}

function sanitizePatchPath(value) {
  return String(value ?? "file").replace(/[\r\n\t]/g, " ");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isErrno(error, code) {
  return isRecord(error) && error.code === code;
}

function mergeStats(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
}

function printSummary(stats, context) {
  const saved = stats.bytesBefore - stats.bytesAfter;
  console.log(`${context.write ? "Migrated" : "Dry run"}: ${context.files} JSONL file(s)`);
  console.log(`changed files: ${stats.filesChanged}`);
  console.log(`changed lines: ${stats.linesChanged}`);
  console.log(`apply_patch details migrated: ${stats.detailsMigrated}`);
  console.log(`changes added: ${stats.changesAdded}`);
  console.log(`previews removed: ${stats.previewsRemoved}`);
  console.log(`result pierre removed: ${stats.resultPierreRemoved}`);
  console.log(`result diff removed: ${stats.resultDiffRemoved}`);
  console.log(`bytes before: ${formatBytes(stats.bytesBefore)}`);
  console.log(`bytes after:  ${formatBytes(stats.bytesAfter)}`);
  console.log(`bytes saved:  ${formatBytes(saved)}`);
  if (stats.parseErrors > 0) console.log(`parse errors: ${stats.parseErrors}`);
  if (!context.write && stats.filesChanged > 0) {
    console.log("Run again with --write to rewrite files.");
  }
}

function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") {
      const text = unit === "B" ? String(value) : value.toFixed(value >= 10 ? 1 : 2);
      return `${sign}${text} ${unit}`;
    }
    value /= 1024;
  }
  return `${sign}${value} B`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
