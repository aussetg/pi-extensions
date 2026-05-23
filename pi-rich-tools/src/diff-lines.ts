import { normalizeLineEndings } from "./util.ts";

const FIRST_CHANGED_LINE_CACHE_LIMIT = 256;
const firstChangedLineCache = new Map<string, number>();

export function firstChangedLineFromDiff(diff: string): number {
  const cached = firstChangedLineCache.get(diff);
  if (typeof cached === "number") return cached;

  const lines = normalizeLineEndings(diff).split("\n");
  let oldLine = 1;
  let newLine = 1;
  let result = 1;
  for (const line of lines) {
    if (line.startsWith("+")) {
      result = newLine;
      break;
    }
    if (line.startsWith("-")) {
      result = oldLine;
      break;
    }
    if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }

  firstChangedLineCache.set(diff, result);
  if (firstChangedLineCache.size > FIRST_CHANGED_LINE_CACHE_LIMIT) {
    const oldestKey = firstChangedLineCache.keys().next().value;
    if (typeof oldestKey === "string") firstChangedLineCache.delete(oldestKey);
  }

  return result;
}
