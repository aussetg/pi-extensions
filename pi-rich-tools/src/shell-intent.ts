import path from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

export type ParsedShellCommand =
  | { type: "read"; cmd: string; name: string; path: string }
  | { type: "list_files"; cmd: string; path?: string }
  | { type: "search"; cmd: string; query?: string; path?: string }
  | { type: "unknown"; cmd: string };

type TreeSitterNode = {
  type: string;
  text: string;
  startIndex?: number;
  hasError?: boolean;
  isNamed?: boolean;
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
};

type TreeSitterTree = { rootNode: TreeSitterNode };
type TreeSitterParser = {
  setLanguage: (language: unknown) => void;
  parse: (source: string) => TreeSitterTree | null;
};
type TreeSitterParserConstructor = new () => TreeSitterParser;

let bashParser: TreeSitterParser | null | undefined;

type ParseCacheEntry = { parsed: ParsedShellCommand[]; chars: number };
type ParseCache = { map: Map<string, ParseCacheEntry>; chars: number };

const MAX_PARSE_CACHE_ENTRIES = 512;
const MAX_PARSE_CACHE_CHARS = 512 * 1024;
const MAX_CACHEABLE_COMMAND_CHARS = 16 * 1024;
const parseCache: ParseCache = { map: new Map(), chars: 0 };
const fallbackParseCache: ParseCache = { map: new Map(), chars: 0 };

export function parseShellCommand(command: string): ParsedShellCommand[] {
  const cached = cachedParsedShellCommand(command);
  if (cached) return cached;

  const parsed = parseShellCommandImpl(command).map(compactParsedCommand);
  const deduped: ParsedShellCommand[] = [];
  for (const item of parsed) {
    if (deduped.length > 0 && sameParsedCommand(deduped[deduped.length - 1]!, item)) continue;
    deduped.push(item);
  }

  if (deduped.some((item) => item.type === "unknown")) {
    const unknownCommand: ParsedShellCommand[] = [{ type: "unknown", cmd: command.trim() || command }];
    rememberParsedShellCommand(command, unknownCommand);
    return unknownCommand;
  }

  rememberParsedShellCommand(command, deduped);
  return deduped;
}

function cachedParsedShellCommand(command: string): ParsedShellCommand[] | undefined {
  const cache = currentParseCache();
  const cached = cache.map.get(command);
  if (!cached) return undefined;

  cache.map.delete(command);
  cache.map.set(command, cached);
  return cloneParsedCommands(cached.parsed);
}

function rememberParsedShellCommand(command: string, parsed: ParsedShellCommand[]): void {
  if (command.length > MAX_CACHEABLE_COMMAND_CHARS) return;

  const cache = currentParseCache();
  const previous = cache.map.get(command);
  if (previous) {
    cache.chars -= previous.chars;
    cache.map.delete(command);
  }

  const entry: ParseCacheEntry = {
    parsed: cloneParsedCommands(parsed),
    chars: command.length + parsedCommandsChars(parsed),
  };
  if (entry.chars > MAX_PARSE_CACHE_CHARS) return;

  cache.map.set(command, entry);
  cache.chars += entry.chars;
  trimParseCache(cache);
}

function trimParseCache(cache: ParseCache): void {
  while (cache.map.size > MAX_PARSE_CACHE_ENTRIES || cache.chars > MAX_PARSE_CACHE_CHARS) {
    const oldest = cache.map.keys().next().value;
    if (typeof oldest !== "string") return;
    const entry = cache.map.get(oldest);
    if (entry) cache.chars -= entry.chars;
    cache.map.delete(oldest);
  }
}

function currentParseCache(): ParseCache {
  return process.env.PI_RICH_TOOLS_SHELL_INTENT_FALLBACK === "1" ? fallbackParseCache : parseCache;
}

function cloneParsedCommands(parsed: ParsedShellCommand[]): ParsedShellCommand[] {
  return parsed.map((item) => ({ ...item }));
}

function parsedCommandsChars(parsed: ParsedShellCommand[]): number {
  let chars = 0;
  for (const item of parsed) {
    chars += item.type.length + item.cmd.length;
    if (item.type === "read") chars += item.name.length + item.path.length;
    else if (item.type === "list_files") chars += item.path?.length ?? 0;
    else if (item.type === "search") chars += (item.query?.length ?? 0) + (item.path?.length ?? 0);
  }
  return chars;
}

function parseShellCommandImpl(command: string): ParsedShellCommand[] {
  const wordCommands = parseWordOnlyCommandSequence(command);
  if (!wordCommands || wordCommands.length === 0) {
    return [{ type: "unknown", cmd: command.trim() || command }];
  }

  const commands = dropSmallFormattingCommands(wordCommands);
  if (commands.length === 0) {
    return [{ type: "unknown", cmd: command.trim() || command }];
  }

  const parsed: ParsedShellCommand[] = [];
  let cwd: string | undefined;

  for (const tokens of commands) {
    const [head, ...tail] = tokens;
    if (head === "cd") {
      const target = cdTarget(tail);
      if (target) cwd = cwd ? joinPaths(cwd, target) : target;
      continue;
    }

    const item = summarizeMainTokens(tokens);
    if (item.type === "read" && cwd) {
      parsed.push({ ...item, path: joinPaths(cwd, item.path) });
    } else {
      parsed.push(item);
    }
  }

  return simplifyParsedCommands(parsed);
}

function parseWordOnlyCommandSequence(source: string): string[][] | undefined {
  if (process.env.PI_RICH_TOOLS_SHELL_INTENT_FALLBACK === "1") return parseWithFallbackTokenizer(source);

  const parser = getBashParser();
  if (!parser) return parseWithFallbackTokenizer(source);

  const tree = parser.parse(source);
  const root = tree?.rootNode;
  if (!root || root.hasError) return undefined;

  const allowedKinds = new Set([
    "program",
    "list",
    "pipeline",
    "command",
    "command_name",
    "word",
    "string",
    "string_content",
    "raw_string",
    "number",
    "concatenation",
  ]);
  const allowedPunctuation = new Set(["&&", "||", ";", "|", "\"", "'"]);
  const commandNodes: TreeSitterNode[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const isNamed = node.isNamed ?? true;
    if (isNamed) {
      if (!allowedKinds.has(node.type)) return undefined;
      if (node.type === "command") commandNodes.push(node);
    } else {
      const punctuationish = /[&;|]/.test(node.type);
      if (punctuationish && !allowedPunctuation.has(node.type)) return undefined;
      if (!allowedPunctuation.has(node.type) && node.type.trim() !== "") return undefined;
    }

    for (const child of node.children ?? []) stack.push(child);
  }

  commandNodes.sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));

  const out: string[][] = [];
  for (const commandNode of commandNodes) {
    const words = parsePlainCommandFromNode(commandNode);
    if (!words) return undefined;
    out.push(words);
  }
  return out;
}

function getBashParser(): TreeSitterParser | undefined {
  if (bashParser !== undefined) return bashParser ?? undefined;

  try {
    const Parser = nodeRequire("tree-sitter") as TreeSitterParserConstructor;
    const Bash = nodeRequire("tree-sitter-bash") as unknown;
    const parser = new Parser();
    parser.setLanguage(Bash);
    bashParser = parser;
  } catch {
    bashParser = null;
  }

  return bashParser ?? undefined;
}

function parsePlainCommandFromNode(command: TreeSitterNode): string[] | undefined {
  if (command.type !== "command") return undefined;

  const words: string[] = [];
  for (const child of command.namedChildren ?? []) {
    switch (child.type) {
      case "command_name": {
        const word = child.namedChildren?.[0];
        if (!word || word.type !== "word") return undefined;
        words.push(word.text);
        break;
      }
      case "word":
      case "number":
        words.push(child.text);
        break;
      case "string": {
        const parsed = parseDoubleQuotedString(child);
        if (parsed === undefined) return undefined;
        words.push(parsed);
        break;
      }
      case "raw_string": {
        const parsed = parseRawString(child);
        if (parsed === undefined) return undefined;
        words.push(parsed);
        break;
      }
      case "concatenation": {
        const parsed = parseConcatenation(child);
        if (parsed === undefined) return undefined;
        words.push(parsed);
        break;
      }
      default:
        return undefined;
    }
  }

  return words.length > 0 ? words : undefined;
}

function parseDoubleQuotedString(node: TreeSitterNode): string | undefined {
  if (node.type !== "string") return undefined;
  if ((node.namedChildren ?? []).some((child) => child.type !== "string_content")) return undefined;
  if (!node.text.startsWith('"') || !node.text.endsWith('"')) return undefined;
  return parseDoubleQuotedStringBody(node.text.slice(1, -1));
}

function parseDoubleQuotedStringBody(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }

    const next = body[i + 1];
    if (next === undefined) {
      out += char;
      continue;
    }
    if (next === "\n") {
      i += 1;
      continue;
    }
    if (next === "\r" && body[i + 2] === "\n") {
      i += 2;
      continue;
    }
    if (next === "$" || next === "`" || next === '"' || next === "\\") {
      out += next;
      i += 1;
      continue;
    }

    out += char;
  }
  return out;
}

function parseRawString(node: TreeSitterNode): string | undefined {
  if (node.type !== "raw_string") return undefined;
  if (!node.text.startsWith("'") || !node.text.endsWith("'")) return undefined;
  return node.text.slice(1, -1);
}

function parseConcatenation(node: TreeSitterNode): string | undefined {
  let out = "";
  for (const child of node.namedChildren ?? []) {
    if (child.type === "word" || child.type === "number") {
      out += child.text;
    } else if (child.type === "string") {
      const parsed = parseDoubleQuotedString(child);
      if (parsed === undefined) return undefined;
      out += parsed;
    } else if (child.type === "raw_string") {
      const parsed = parseRawString(child);
      if (parsed === undefined) return undefined;
      out += parsed;
    } else {
      return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseWithFallbackTokenizer(source: string): string[][] | undefined {
  const tokens = tokenizeSimpleShell(source);
  if (!tokens) return undefined;
  const out: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === ";" || token === "|") {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function tokenizeSimpleShell(source: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (current) tokens.push(current);
      current = "";
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      tokens.push(";");
      continue;
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }

    if (char === "&" || char === "|") {
      if (current) tokens.push(current);
      current = "";
      if (source[i + 1] === char) {
        tokens.push(char + char);
        i += 1;
      } else if (char === "|") {
        tokens.push(char);
      } else {
        return undefined;
      }
      continue;
    }

    if (char === ";") {
      if (current) tokens.push(current);
      current = "";
      tokens.push(char);
      continue;
    }

    if ("<>(){}$`".includes(char)) return undefined;
    current += char;
  }

  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

function summarizeMainTokens(tokens: string[]): ParsedShellCommand {
  const [head, ...tail] = tokens;
  if (!head) return { type: "unknown", cmd: shellJoin(tokens) };

  if (head === "ls" || head === "eza" || head === "exa") {
    const flagsWithValues = head === "ls"
      ? ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"]
      : ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
    return {
      type: "list_files",
      cmd: shellJoin(tokens),
      path: firstNonFlagOperand(tail, flagsWithValues),
    };
  }

  if (head === "tree") {
    return {
      type: "list_files",
      cmd: shellJoin(tokens),
      path: firstNonFlagOperand(tail, ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]),
    };
  }

  if (head === "du") {
    return {
      type: "list_files",
      cmd: shellJoin(tokens),
      path: firstNonFlagOperand(tail, ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"]),
    };
  }

  if (head === "rg" || head === "rga" || head === "ripgrep-all") {
    const hasFilesFlag = tail.includes("--files");
    const candidates = skipFlagValues(tail, [
      "-g",
      "--glob",
      "--iglob",
      "-t",
      "--type",
      "--type-add",
      "--type-not",
      "-m",
      "--max-count",
      "-A",
      "-B",
      "-C",
      "--context",
      "--max-depth",
    ]).filter((arg) => !arg.startsWith("-"));

    if (hasFilesFlag) {
      return { type: "list_files", cmd: shellJoin(tokens), path: candidates[0] };
    }
    return {
      type: "search",
      cmd: shellJoin(tokens),
      query: candidates[0],
      path: candidates[1],
    };
  }

  if (head === "git") {
    const [subcmd, ...subTail] = tail;
    if (subcmd === "grep") return parseGrepLike(tokens, subTail);
    if (subcmd === "ls-files") {
      return {
        type: "list_files",
        cmd: shellJoin(tokens),
        path: firstNonFlagOperand(subTail, ["--exclude", "--exclude-from", "--pathspec-from-file"]),
      };
    }
    return { type: "unknown", cmd: shellJoin(tokens) };
  }

  if (head === "fd") {
    if (hasFdExecAction(tail)) return { type: "unknown", cmd: shellJoin(tokens) };
    const [query, itemPath] = parseFdQueryAndPath(tail);
    if (query) return { type: "search", cmd: shellJoin(tokens), query, path: itemPath };
    return { type: "list_files", cmd: shellJoin(tokens), path: itemPath };
  }

  if (head === "find") {
    if (hasFindSideEffectAction(tail)) return { type: "unknown", cmd: shellJoin(tokens) };
    const [query, itemPath] = parseFindQueryAndPath(tail);
    if (query) return { type: "search", cmd: shellJoin(tokens), query, path: itemPath };
    return { type: "list_files", cmd: shellJoin(tokens), path: itemPath };
  }

  if (head === "grep" || head === "egrep" || head === "fgrep") return parseGrepLike(tokens, tail);

  if (head === "ag" || head === "ack" || head === "pt") {
    const candidates = skipFlagValues(tail, [
      "-G",
      "-g",
      "--file-search-regex",
      "--ignore-dir",
      "--ignore-file",
      "--path-to-ignore",
    ]).filter((arg) => !arg.startsWith("-"));
    return {
      type: "search",
      cmd: shellJoin(tokens),
      query: candidates[0],
      path: candidates[1],
    };
  }

  if (head === "cat") return readFromSingleOperand(tokens, tail, []);
  if (head === "bat" || head === "batcat") {
    return readFromSingleOperand(tokens, tail, [
      "--theme",
      "--language",
      "--style",
      "--terminal-width",
      "--tabs",
      "--line-range",
      "--map-syntax",
    ]);
  }
  if (head === "less") {
    return readFromSingleOperand(tokens, tail, [
      "-p",
      "-P",
      "-x",
      "-y",
      "-z",
      "-j",
      "--pattern",
      "--prompt",
      "--tabs",
      "--shift",
      "--jump-target",
    ]);
  }
  if (head === "more") return readFromSingleOperand(tokens, tail, []);
  if (head === "head") return parseHeadRead(tokens, tail);
  if (head === "tail") return parseTailRead(tokens, tail);
  if (head === "awk") {
    const dataPath = awkReadPath(tail);
    if (dataPath) return readCommand(tokens, dataPath);
    return { type: "unknown", cmd: shellJoin(tokens) };
  }
  if (head === "nl") {
    const candidate = singleNonFlagOperand(tail, [
      "-b",
      "-d",
      "-f",
      "-h",
      "-i",
      "-l",
      "-n",
      "-s",
      "-v",
      "-w",
      "--body-numbering",
      "--footer-numbering",
      "--header-numbering",
      "--join-blank-lines",
      "--line-increment",
      "--number-format",
      "--number-separator",
      "--number-width",
      "--section-delimiter",
      "--starting-line-number",
    ]);
    if (candidate) return readCommand(tokens, candidate);
    return { type: "unknown", cmd: shellJoin(tokens) };
  }
  if (head === "sed") {
    const readPath = sedReadPath(tail);
    if (readPath) return readCommand(tokens, readPath);
    return { type: "unknown", cmd: shellJoin(tokens) };
  }

  return { type: "unknown", cmd: shellJoin(tokens) };
}

function parseGrepLike(tokens: string[], args: string[]): ParsedShellCommand {
  const operands: string[] = [];
  let pattern: string | undefined;
  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (afterDoubleDash) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
      if (pattern === undefined && args[i + 1] !== undefined) pattern = args[i + 1];
      i += 1;
      continue;
    }
    if (["-m", "--max-count", "-C", "--context", "-A", "--after-context", "-B", "--before-context"].includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    operands.push(arg);
  }

  const hasPattern = pattern !== undefined;
  const query = pattern ?? operands[0];
  const pathIndex = hasPattern ? 0 : 1;
  return { type: "search", cmd: shellJoin(tokens), query, path: operands[pathIndex] };
}

function readFromSingleOperand(tokens: string[], args: string[], flagsWithValues: string[]): ParsedShellCommand {
  const operand = singleNonFlagOperand(args, flagsWithValues);
  if (!operand) return { type: "unknown", cmd: shellJoin(tokens) };
  return readCommand(tokens, operand);
}

function readCommand(tokens: string[], readPath: string): ParsedShellCommand {
  return {
    type: "read",
    cmd: shellJoin(tokens),
    name: shortDisplayPath(readPath),
    path: readPath,
  };
}

function parseHeadRead(tokens: string[], args: string[]): ParsedShellCommand {
  const pathArg = headTailReadPath(args, false);
  if (pathArg) return readCommand(tokens, pathArg);
  return { type: "unknown", cmd: shellJoin(tokens) };
}

function parseTailRead(tokens: string[], args: string[]): ParsedShellCommand {
  const pathArg = headTailReadPath(args, true);
  if (pathArg) return readCommand(tokens, pathArg);
  return { type: "unknown", cmd: shellJoin(tokens) };
}

function headTailReadPath(args: string[], allowPlus: boolean): string | undefined {
  if (args.length === 1 && !args[0]!.startsWith("-")) return args[0];

  const first = args[0];
  if (!first) return undefined;
  let skip = 0;
  if (first === "-n" || first === "-c") {
    const count = args[1];
    if (count && validCount(count, allowPlus)) skip = 2;
  } else if ((first.startsWith("-n") || first.startsWith("-c")) && validCount(first.slice(2), allowPlus)) {
    skip = 1;
  }
  if (skip === 0) return undefined;
  return args.slice(skip).find((arg) => !arg.startsWith("-"));
}

function validCount(value: string, allowPlus: boolean): boolean {
  const core = allowPlus ? value.replace(/^\+/, "") : value;
  return core.length > 0 && /^\d+$/.test(core);
}

function sedReadPath(args: string[]): string | undefined {
  let quiet = false;
  let hasPrintScript = false;
  let sawScript = false;
  const files: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if (afterDoubleDash) {
      files.push(arg);
      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place=")) {
      return undefined;
    }

    if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
      continue;
    }

    if (isSedShortFlagCluster(arg)) {
      if (arg.includes("n")) quiet = true;
      continue;
    }

    if (arg === "-e" || arg === "--expression") {
      sawScript = true;
      if (isValidSedPrintScript(args[i + 1])) hasPrintScript = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("-e") && arg.length > 2) {
      sawScript = true;
      if (isValidSedPrintScript(arg.slice(2))) hasPrintScript = true;
      continue;
    }

    if (arg.startsWith("--expression=")) {
      sawScript = true;
      if (isValidSedPrintScript(arg.slice("--expression=".length))) hasPrintScript = true;
      continue;
    }

    if (arg === "-f" || arg === "--file") {
      sawScript = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--file=")) {
      sawScript = true;
      continue;
    }
    if (arg.startsWith("-")) continue;

    if (!sawScript) {
      sawScript = true;
      if (!isValidSedPrintScript(arg)) return undefined;
      hasPrintScript = true;
      continue;
    }

    files.push(arg);
  }

  if (!quiet || !hasPrintScript || files.length !== 1) return undefined;
  return files[0];
}

function isSedShortFlagCluster(arg: string): boolean {
  return /^-[Enrsuz]+$/.test(arg);
}

function isValidSedPrintScript(arg: string | undefined): boolean {
  const core = arg?.endsWith("p") ? arg.slice(0, -1) : undefined;
  if (!core) return false;
  const parts = core.split(",");
  return (parts.length === 1 || parts.length === 2) && parts.every(isValidSedAddress);
}

function isValidSedAddress(address: string): boolean {
  return /^\d+$/.test(address) || /^\/[^/]+\/$/.test(address) || /^\+\d+$/.test(address);
}

function awkReadPath(args: string[]): string | undefined {
  const parsed = parseSimpleAwkArgs(args);
  if (!parsed || !isSafeAwkPrintScript(parsed.script) || parsed.dataFiles.length !== 1) return undefined;
  return parsed.dataFiles[0];
}

function isSafeAwkFormatter(args: string[]): boolean {
  const parsed = parseSimpleAwkArgs(args);
  return Boolean(parsed && parsed.dataFiles.length === 0 && isSafeAwkPrintScript(parsed.script));
}

function parseSimpleAwkArgs(args: string[]): { script: string; dataFiles: string[] } | undefined {
  if (args.some((arg) => arg === "-f" || arg === "--file" || arg.startsWith("--file="))) return undefined;
  const operands = skipFlagValues(args, ["-F", "-v", "-f", "--field-separator", "--assign", "--file"]).filter((arg) => !arg.startsWith("-"));
  const [script, ...dataFiles] = operands;
  return script ? { script, dataFiles } : undefined;
}

function isSafeAwkPrintScript(script: string): boolean {
  const source = script.trim().replace(/\s+/g, " ");
  const value = String.raw`(?:\$\d+|\$0|NF|NR)`;
  const print = String.raw`\{\s*print(?:\s+${value}(?:\s*,\s*${value})*)?\s*\}`;
  const nrAddress = String.raw`NR\s*(?:==|!=|<=|>=|<|>)\s*\d+(?:\s*&&\s*NR\s*(?:==|!=|<=|>=|<|>)\s*\d+)?`;
  const regexAddress = String.raw`\/[^/]+\/`;
  return source === "1"
    || new RegExp(String.raw`^${print}$`).test(source)
    || new RegExp(String.raw`^(?:${nrAddress}|${regexAddress})(?:\s*${print})?$`).test(source);
}

function parseFdQueryAndPath(args: string[]): [string | undefined, string | undefined] {
  const nonFlags = skipFlagValues(args, ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"]).filter((arg) => !arg.startsWith("-"));
  if (nonFlags.length === 1) {
    const one = nonFlags[0]!;
    return isPathish(one) ? [undefined, one] : [one, undefined];
  }
  if (nonFlags.length >= 2) return [nonFlags[0], nonFlags[1]!];
  return [undefined, undefined];
}

function hasFdExecAction(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "-x" || arg === "-X" || arg === "--exec" || arg === "--exec-batch") return true;
    if (arg.startsWith("--exec=") || arg.startsWith("--exec-batch=")) return true;
    if (/^-[A-Za-z]*[xX][A-Za-z]*$/.test(arg)) return true;
  }
  return false;
}

function parseFindQueryAndPath(args: string[]): [string | undefined, string | undefined] {
  const itemPath = findLeadingPathOperand(args);
  let query: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-name" || args[i] === "-iname" || args[i] === "-path" || args[i] === "-regex") {
      query = args[i + 1];
      break;
    }
  }
  return [query, itemPath];
}

function findLeadingPathOperand(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "!" || arg === "(" || arg === ")" || arg === "," || arg.startsWith("-")) return undefined;
    return arg;
  }
  return undefined;
}

function hasFindSideEffectAction(args: string[]): boolean {
  const sideEffectActions = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ]);
  return args.some((arg) => sideEffectActions.has(arg));
}

function isSmallFormattingCommand(tokens: string[]): boolean {
  const [head, ...tail] = tokens;
  if (!head) return false;
  if (["wc", "tr", "cut", "sort", "uniq", "column", "yes", "printf"].includes(head)) return true;
  if (head === "tee") return !teeHasFileOperands(tail);
  if (head === "awk") return isSafeAwkFormatter(tail);
  if (head === "sed") return sedReadPath(tail) === undefined;
  if (head === "head") return headTailReadPath(tail, false) === undefined;
  if (head === "tail") return headTailReadPath(tail, true) === undefined;
  if (head === "xargs") return isSafeXargsFormattingCommand(tokens);
  return false;
}

function teeHasFileOperands(args: string[]): boolean {
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) return true;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "--output-error" || arg.startsWith("--output-error=")) continue;
    if (arg.startsWith("-")) continue;
    return true;
  }
  return false;
}

function isSafeXargsFormattingCommand(tokens: string[]): boolean {
  const subcommand = xargsSubcommand(tokens);
  if (!subcommand) return true;
  const [head] = subcommand;
  return head === "echo" || head === "printf";
}

function xargsSubcommand(tokens: string[]): string[] | undefined {
  if (tokens[0] !== "xargs") return undefined;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      const rest = tokens.slice(i + 1);
      return rest.length > 0 ? rest : undefined;
    }
    if (!token.startsWith("-")) return tokens.slice(i);
    if (["-E", "-e", "-I", "-L", "-n", "-P", "-s"].includes(token) && token.length === 2) i += 1;
  }
  return undefined;
}

function dropSmallFormattingCommands(commands: string[][]): string[][] {
  return commands.filter((tokens) => !isSmallFormattingCommand(tokens));
}

function simplifyParsedCommands(commands: ParsedShellCommand[]): ParsedShellCommand[] {
  let out = [...commands];
  let changed = true;
  while (changed) {
    changed = false;
    if (out.length > 1 && out[0]?.type === "unknown" && tokenizeSimpleShell(out[0].cmd)?.[0] === "echo") {
      out = out.slice(1);
      changed = true;
      continue;
    }
    const trueIndex = out.findIndex((item) => item.type === "unknown" && item.cmd === "true");
    if (trueIndex !== -1 && out.length > 1) {
      out.splice(trueIndex, 1);
      changed = true;
    }
  }
  return out;
}

function skipFlagValues(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (afterDoubleDash) {
      out.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flagsWithValues.includes(arg)) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function firstNonFlagOperand(args: string[], flagsWithValues: string[]): string | undefined {
  return positionalOperands(args, flagsWithValues)[0];
}

function singleNonFlagOperand(args: string[], flagsWithValues: string[]): string | undefined {
  const operands = positionalOperands(args, flagsWithValues);
  return operands.length === 1 ? operands[0] : undefined;
}

function positionalOperands(args: string[], flagsWithValues: string[]): string[] {
  return skipFlagValues(args, flagsWithValues).filter((arg) => !arg.startsWith("-"));
}

function cdTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (arg === "-L" || arg === "-P" || arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function isPathish(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.includes("/") || value.includes("\\");
}

function shortDisplayPath(itemPath: string): string {
  const normalized = itemPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const parts = normalized.split("/").filter((part) => part && !["build", "dist", "node_modules", "src"].includes(part));
  return parts[parts.length - 1] || normalized || itemPath;
}

function joinPaths(base: string, rel: string): string {
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) return rel;
  if (!base) return rel;
  return path.join(base, rel);
}

function shellJoin(tokens: string[]): string {
  return tokens.map(shellQuote).join(" ");
}

function shellQuote(token: string): string {
  if (token.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'"'"'`)}'`;
}

function sameParsedCommand(left: ParsedShellCommand, right: ParsedShellCommand): boolean {
  if (left.type !== right.type || left.cmd !== right.cmd) return false;
  switch (left.type) {
    case "read":
      return right.type === "read" && left.name === right.name && left.path === right.path;
    case "list_files":
      return right.type === "list_files" && left.path === right.path;
    case "search":
      return right.type === "search" && left.query === right.query && left.path === right.path;
    case "unknown":
      return right.type === "unknown";
  }
}

function compactParsedCommand(item: ParsedShellCommand): ParsedShellCommand {
  switch (item.type) {
    case "list_files":
      return item.path === undefined ? { type: item.type, cmd: item.cmd } : item;
    case "search": {
      const compact: ParsedShellCommand = { type: item.type, cmd: item.cmd };
      if (item.query !== undefined) compact.query = item.query;
      if (item.path !== undefined) compact.path = item.path;
      return compact;
    }
    case "read":
    case "unknown":
      return item;
  }
}

