import { normalizeLineEndings } from "./util.ts";

type NumberedDiffLine =
  | { kind: "gap" }
  | {
      kind: "line";
      sign: " " | "+" | "-";
      lineNumber: number;
      content: string;
    };

export function unifiedPatchFromNumberedDiff(options: {
  oldPath: string;
  newPath: string;
  diff: string;
}): string | undefined {
  const normalizedDiff = normalizeLineEndings(options.diff);
  if (!normalizedDiff.trim()) {
    return options.oldPath === options.newPath
      ? undefined
      : headerOnlyUnifiedPatch(options.oldPath, options.newPath);
  }

  const parsed: NumberedDiffLine[] = [];
  for (const line of normalizedDiff.split("\n")) {
    if (line === "") continue;
    const parsedLine = parseNumberedDiffLine(line);
    if (!parsedLine) return undefined;
    parsed.push(parsedLine);
  }

  const hunks: Array<Extract<NumberedDiffLine, { kind: "line" }>[]> = [];
  let current: Array<Extract<NumberedDiffLine, { kind: "line" }>> = [];
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

function headerOnlyUnifiedPatch(oldPath: string, newPath: string): string {
  return `${unifiedPatchHeader(oldPath, newPath).join("\n")}\n`;
}

function unifiedPatchHeader(oldPath: string, newPath: string): string[] {
  const oldSafe = sanitizePatchPath(oldPath);
  const newSafe = sanitizePatchPath(newPath);
  const out: string[] = [];
  if (oldSafe === newSafe) out.push(`Index: ${oldSafe}`);
  out.push("===================================================================");
  out.push(`--- ${oldSafe}`);
  out.push(`+++ ${newSafe}`);
  return out;
}

function parseNumberedDiffLine(line: string): NumberedDiffLine | undefined {
  const sign = line[0];
  if (sign !== " " && sign !== "+" && sign !== "-") return undefined;

  const rest = line.slice(1);
  if (sign === " " && /^ +\.\.\.$/.test(rest)) return { kind: "gap" };

  const match = /^ *(\d+) (.*)$/.exec(rest);
  if (!match) return undefined;

  return {
    kind: "line",
    sign,
    lineNumber: Number.parseInt(match[1]!, 10),
    content: match[2] ?? "",
  };
}

function numberedDiffHunkHeader(
  hunk: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
  deltaBefore: number,
): { text: string; oldLines: number; newLines: number } {
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

function oldHunkStart(
  oldLines: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
  newLines: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
  deltaBefore: number,
): number {
  const firstOld = oldLines[0]?.lineNumber;
  if (typeof firstOld === "number") return firstOld;

  const firstNew = newLines[0]?.lineNumber;
  if (typeof firstNew === "number") return Math.max(0, firstNew - deltaBefore - 1);

  return 0;
}

function newHunkStart(
  hunk: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
  oldStart: number,
  deltaBefore: number,
  newLineCount: number,
): number {
  if (newLineCount === 0) return Math.max(0, oldStart + deltaBefore - 1);

  const firstLine = hunk[0];
  if (firstLine?.sign === "+") return firstLine.lineNumber;

  return Math.max(0, oldStart + deltaBefore);
}

function sanitizePatchPath(path: string): string {
  return path.replace(/[\r\n\t]/g, " ");
}
