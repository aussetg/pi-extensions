import { hashText } from "./hash.ts";

const FIRST_CHANGED_LINE_CACHE_LIMIT = 256;
const firstChangedLineCache = new Map<string, number>();

export function firstChangedLineFromDiff(diff: string): number {
  const cacheKey = firstChangedLineCacheKey(diff);
  const cached = firstChangedLineCache.get(cacheKey);
  if (typeof cached === "number") return cached;

  let oldLine = 1;
  let newLine = 1;
  let result = 1;

  for (const line of iterateLines(diff)) {
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

  firstChangedLineCache.set(cacheKey, result);
  if (firstChangedLineCache.size > FIRST_CHANGED_LINE_CACHE_LIMIT) {
    const oldestKey = firstChangedLineCache.keys().next().value;
    if (typeof oldestKey === "string") firstChangedLineCache.delete(oldestKey);
  }

  return result;
}

function firstChangedLineCacheKey(diff: string): string {
  return `${diff.length}:${hashText(diff, 16)}`;
}

function* iterateLines(text: string): Iterable<string> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    yield text.slice(start, index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    start = index + 1;
  }
  yield text.slice(start);
}
