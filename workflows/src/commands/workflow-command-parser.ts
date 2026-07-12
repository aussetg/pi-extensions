export type WorkflowCommand =
  | { action: "manager" }
  | { action: "enable" | "disable" | "toggle" | "status" }
  | { action: "list"; filter: "running" | "completed" | "all" }
  | { action: "run"; target: string; args?: Record<string, unknown>; mode?: "await" | "async" }
  | { action: "save"; runId: string; scope: "project" | "user"; name?: string }
  | { action: "resume"; runId: string; scriptPath?: string; args?: Record<string, unknown>; mode?: "await" | "async" }
  | { action: "stop" | "pause" | "continue" | "delete"; runId: string }
  | { action: "skip-agent"; runId: string; callId: string }
  | { action: "open"; runId: string; target: "result" | "script" | "journal" | "transcripts" };

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
      if (target.startsWith("--")) throw new Error("Usage: /workflow run <name|scriptPath> [--args <json>] [--await|--async]");
      return { action: "run", target, ...parseCommonOptions(argv) };
    }
    case "save": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow save <runId> [--scope project|user] [--name <slug>]");
      if (runId.startsWith("--")) throw new Error("Usage: /workflow save <runId> [--scope project|user] [--name <slug>]");
      return { action: "save", runId, ...parseSaveOptions(argv) };
    }
    case "resume": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]");
      if (runId.startsWith("--")) throw new Error("Usage: /workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]");
      return { action: "resume", runId, ...parseResumeOptions(argv) };
    }
    case "stop":
    case "pause":
    case "continue":
    case "delete": {
      const runId = argv.shift();
      if (!runId) throw new Error(`Usage: /workflow ${action} <runId>`);
      if (runId.startsWith("--") || argv.length > 0) throw new Error(`Usage: /workflow ${action} <runId>`);
      return { action, runId };
    }
    case "skip-agent": {
      const runId = argv.shift();
      const callId = argv.shift();
      if (!runId || !callId) throw new Error(`Usage: /workflow ${action} <runId> <callId>`);
      if (runId.startsWith("--") || callId.startsWith("--") || argv.length > 0) throw new Error(`Usage: /workflow ${action} <runId> <callId>`);
      return { action, runId, callId };
    }
    case "open": {
      const runId = argv.shift();
      if (!runId) throw new Error("Usage: /workflow open <runId> [result|script|journal|transcripts]");
      const target = argv.shift() ?? "result";
      if (!isOpenTarget(target)) throw new Error("Open target must be result, script, journal, or transcripts");
      if (argv.length > 0) throw new Error("Too many arguments for /workflow open");
      return { action: "open", runId, target };
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
    "/workflow skip-agent <runId> <callId>",
    "/workflow open <runId> [result|script|journal|transcripts]",
  ].join("\n");
}

function parseListFilter(argv: string[]): "running" | "completed" | "all" {
  let filter: "running" | "completed" | "all" = "all";
  let seen = false;
  for (const arg of argv) {
    if (arg === "--running" || arg === "--completed" || arg === "--all") {
      if (seen) throw new Error("Use only one list filter");
      seen = true;
      filter = arg === "--running" ? "running" : arg === "--completed" ? "completed" : "all";
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown list option: ${arg}`);
    throw new Error(`Unexpected argument for /workflow list: ${arg}`);
  }
  return filter;
}

function parseCommonOptions(argv: string[]): { args?: Record<string, unknown>; mode?: "await" | "async" } {
  let args: Record<string, unknown> | undefined;
  let mode: "await" | "async" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--args") {
      if (args !== undefined) throw new Error("Duplicate --args option");
      const value = requireOptionValue(argv, ++i, "--args");
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--args must be a JSON object");
      args = parsed as Record<string, unknown>;
      continue;
    }
    if (arg === "--await" || arg === "--async") {
      const nextMode = arg === "--await" ? "await" : "async";
      if (mode && mode !== nextMode) throw new Error("--await and --async are mutually exclusive");
      if (mode === nextMode) throw new Error(`Duplicate ${arg} option`);
      mode = nextMode;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown workflow option: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return { args, mode };
}

function parseSaveOptions(argv: string[]): { scope: "project" | "user"; name?: string } {
  let scope: "project" | "user" = "project";
  let seenScope = false;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scope") {
      if (seenScope) throw new Error("Duplicate --scope option");
      seenScope = true;
      const value = requireOptionValue(argv, ++i, "--scope");
      if (value !== "project" && value !== "user") throw new Error("--scope must be project or user");
      scope = value;
      continue;
    }
    if (arg === "--name") {
      if (name !== undefined) throw new Error("Duplicate --name option");
      name = requireOptionValue(argv, ++i, "--name");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown save option: ${arg}`);
    throw new Error(`Unexpected argument for /workflow save: ${arg}`);
  }
  return { scope, name };
}

function parseResumeOptions(argv: string[]): { scriptPath?: string; args?: Record<string, unknown>; mode?: "await" | "async" } {
  let scriptPath: string | undefined;
  const commonArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--script") {
      if (scriptPath !== undefined) throw new Error("Duplicate --script option");
      scriptPath = requireOptionValue(argv, ++i, "--script");
      continue;
    }
    commonArgs.push(arg);
    if (arg === "--args") commonArgs.push(requireOptionValue(argv, ++i, "--args"));
  }
  return { scriptPath, ...parseCommonOptions(commonArgs) };
}

function requireOptionValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
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

function isOpenTarget(value: string): value is "result" | "script" | "journal" | "transcripts" {
  return ["result", "script", "journal", "transcripts"].includes(value);
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
