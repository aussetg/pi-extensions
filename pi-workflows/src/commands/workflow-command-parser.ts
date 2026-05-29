export type WorkflowCommand =
  | { action: "manager" }
  | { action: "enable" | "disable" | "toggle" | "status" }
  | { action: "list"; filter: "running" | "completed" | "all" }
  | { action: "run"; target: string; args?: Record<string, unknown>; mode?: "await" | "async" }
  | { action: "save"; runId: string; scope: "project" | "user"; name?: string }
  | { action: "resume"; runId: string; scriptPath?: string; args?: Record<string, unknown>; mode?: "await" | "async" }
  | { action: "stop" | "pause" | "continue" | "delete"; runId: string }
  | { action: "retry-agent" | "skip-agent"; runId: string; callId: string }
  | { action: "open"; runId: string; target: "result" | "script" | "journal" | "transcripts" | "ui"; viewId?: string; profile?: WorkflowOpenProfile; width?: number }
  | { action: "preview-ui"; json: string; profile?: WorkflowOpenProfile; width?: number };

export type WorkflowOpenProfile = "compact" | "panel" | "full";

const MIN_PREVIEW_WIDTH = 20;
const MAX_PREVIEW_WIDTH = 240;

export function parseWorkflowCommand(raw: string): WorkflowCommand {
  const argv = tokenize(raw.trim());
  if (argv.length === 0) return { action: "manager" };
  const action = normalizeAction(argv.shift()!);
  switch (action) {
    case "enable":
    case "disable":
    case "toggle":
    case "status":
      if (argv.length > 0) throw new Error(`Usage: /workflow ${action}`);
      return { action };
    case "list":
      return { action: "list", filter: parseListFilter(argv) };
    case "run": {
      const target = argv.shift();
      if (!target) throw new Error("Usage: /workflow run <name|scriptPath> [--args <json>] [--await|--async]");
      return { action: "run", target, ...parseCommonOptions(argv) };
    }
    case "save": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow save <runId> [--scope project|user] [--name <slug>]");
      const scope = readOption(argv, "--scope") ?? "project";
      if (scope !== "project" && scope !== "user") throw new Error("--scope must be project or user");
      return { action: "save", runId, scope, name: readOption(argv, "--name") };
    }
    case "resume": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]");
      return { action: "resume", runId, scriptPath: readOption(argv, "--script"), ...parseCommonOptions(argv) };
    }
    case "stop":
    case "pause":
    case "continue":
    case "delete": {
      const runId = argv.shift();
      if (!runId) throw new Error(`Usage: /workflow ${action} <runId>`);
      return { action, runId };
    }
    case "retry-agent":
    case "skip-agent": {
      const runId = argv.shift();
      const callId = argv.shift();
      if (!runId || !callId) throw new Error(`Usage: /workflow ${action} <runId> <callId>`);
      return { action, runId, callId };
    }
    case "preview-ui": {
      const json = argv.shift();
      if (!json) throw new Error("Usage: /workflow preview-ui <json> [--profile compact|panel|full] [--width <columns>]");
      const options = parseRenderOptions(argv);
      if (argv.length > 0) throw new Error("Too many arguments for /workflow preview-ui");
      return { action: "preview-ui", json, ...options };
    }
    case "open": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow open <runId> [result|script|journal|transcripts|ui] [viewId] [--profile compact|panel|full] [--width <columns>]");
      const target = argv.shift() ?? "result";
      if (!isOpenTarget(target)) throw new Error("Open target must be result, script, journal, transcripts, or ui");
      const options = parseOpenOptions(target, argv);
      return { action: "open", runId, target, ...options };
    }
    default:
      throw new Error(`Unknown /workflow action: ${action}\n${workflowHelpText()}`);
  }
}

export function workflowHelpText(): string {
  return [
    "/workflow",
    "/workflow enable|disable|toggle|status",
    "/workflow list [--running|--completed|--all]",
    "/workflow run <name|scriptPath> [--args <json>] [--await|--async]",
    "/workflow save <runId> [--scope project|user] [--name <slug>]",
    "/workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]",
    "/workflow stop|pause|continue|delete <runId>",
    "/workflow retry-agent|skip-agent <runId> <callId>",
    "/workflow open <runId> [result|script|journal|transcripts|ui] [viewId] [--profile compact|panel|full] [--width <columns>]",
    "/workflow preview-ui <json> [--profile compact|panel|full] [--width <columns>]",
  ].join("\n");
}

function parseOpenOptions(target: "result" | "script" | "journal" | "transcripts" | "ui", argv: string[]): { viewId?: string; profile?: WorkflowOpenProfile; width?: number } {
  let viewId: string | undefined;
  const options = parseRenderOptions(argv, (arg) => {
    if (target !== "ui") throw new Error("Only /workflow open <runId> ui accepts viewId, --profile, or --width");
    if (viewId !== undefined) throw new Error("Too many view ids for /workflow open <runId> ui");
    viewId = arg;
  });
  if (target !== "ui" && (options.profile !== undefined || options.width !== undefined)) throw new Error("--profile and --width are only valid for /workflow open <runId> ui");
  return { viewId, ...options };
}

function parseRenderOptions(argv: string[], positional?: (arg: string) => void): { profile?: WorkflowOpenProfile; width?: number } {
  let profile: WorkflowOpenProfile | undefined;
  let width: number | undefined;
  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--profile") {
      const value = argv.shift();
      if (!value) throw new Error("--profile requires a value");
      profile = parseProfile(value);
      continue;
    }
    if (arg === "--width") {
      const value = argv.shift();
      if (!value) throw new Error("--width requires a value");
      width = parsePreviewWidth(value);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown render option: ${arg}`);
    if (!positional) throw new Error(`Unexpected argument: ${arg}`);
    positional(arg);
  }
  return { profile, width };
}

function parseProfile(value: string): WorkflowOpenProfile {
  if (value === "compact" || value === "panel" || value === "full") return value;
  throw new Error("--profile must be compact, panel, or full");
}

function parsePreviewWidth(value: string): number {
  const width = Number(value);
  if (!Number.isInteger(width) || width <= 0) throw new Error("--width must be a positive integer");
  return Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, width));
}

function parseListFilter(argv: string[]): "running" | "completed" | "all" {
  const flags = argv.filter((arg) => arg === "--running" || arg === "--completed" || arg === "--all");
  if (flags.length > 1) throw new Error("Use only one list filter");
  return flags[0] === "--running" ? "running" : flags[0] === "--completed" ? "completed" : "all";
}

function parseCommonOptions(argv: string[]): { args?: Record<string, unknown>; mode?: "await" | "async" } {
  const argsRaw = readOption(argv, "--args");
  const hasAwait = argv.includes("--await");
  const hasAsync = argv.includes("--async");
  if (hasAwait && hasAsync) throw new Error("--await and --async are mutually exclusive");
  let args: Record<string, unknown> | undefined;
  if (argsRaw !== undefined) {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--args must be a JSON object");
    args = parsed as Record<string, unknown>;
  }
  return { args, mode: hasAwait ? "await" : hasAsync ? "async" : undefined };
}

function readOption(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function normalizeAction(action: string): string {
  if (action === "on") return "enable";
  if (action === "off") return "disable";
  if (action === "ls") return "list";
  if (action === "cont") return "continue";
  if (action === "rm") return "delete";
  return action;
}

function isOpenTarget(value: string): value is "result" | "script" | "journal" | "transcripts" | "ui" {
  return ["result", "script", "journal", "transcripts", "ui"].includes(value);
}

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += "\\";
  if (quote) throw new Error("Unclosed quote");
  if (cur) out.push(cur);
  return out;
}
