import { tokenizeCommand } from "./command-tokenizer.js";

export type FlowCommand =
  | { action: "help" }
  | { action: "list"; activeOnly: boolean; namespace?: "builtin" | "user" | "project" }
  | { action: "explain"; name: string }
  | { action: "run"; name: string; args: Record<string, unknown>; mode: "await" | "async" }
  | { action: "status"; runRef?: string }
  | { action: "open"; runRef: string }
  | { action: "pause" | "resume" | "stop"; runRef: string }
  | { action: "stop-effect"; runRef: string; operationRef: string }
  | { action: "respond"; runRef: string; checkpointId?: string; challenge?: string; value?: string }
  | { action: "approve" | "reject"; runRef: string; challenge?: string }
  | { action: "replay" | "fresh-run"; sourceRunRef: string; args?: Record<string, unknown>; mode: "await" | "async" }
  | { action: "drafts"; draftId?: string; namespace?: "user" | "project" }
  | { action: "validate"; draftId: string }
  | { action: "promote"; draftId: string; challenge?: string }
  | { action: "discard-draft"; draftId: string; expectedHash?: string }
  | { action: "delete"; runRef: string; challenge?: string };

export const FLOW_SUBCOMMANDS = [
  "list", "explain", "run", "status", "open", "pause", "resume", "stop", "stop-effect",
  "respond", "approve", "reject", "replay", "fresh-run", "drafts", "validate", "promote",
  "discard-draft", "delete", "help",
] as const;

export function parseFlowCommand(raw: string): FlowCommand {
  const argv = tokenizeCommand(raw.trim());
  if (argv.length === 0) return { action: "help" };
  const action = argv.shift()!;
  switch (action) {
    case "help":
      exact(argv, "/flow help");
      return { action: "help" };
    case "list":
      return parseList(argv);
    case "explain": {
      const name = positional(argv, "/flow explain NAME");
      exact(argv, "/flow explain NAME");
      return { action: "explain", name };
    }
    case "run":
      return parseRun(argv);
    case "status": {
      if (argv.length > 1 || argv[0]?.startsWith("--")) throw usage("/flow status [RUN]");
      return { action: "status", ...(argv[0] ? { runRef: argv[0] } : {}) };
    }
    case "open": {
      const runRef = positional(argv, "/flow open RUN");
      exact(argv, "/flow open RUN");
      return { action: "open", runRef };
    }
    case "pause":
    case "resume":
    case "stop": {
      const runRef = positional(argv, `/flow ${action} RUN`);
      exact(argv, `/flow ${action} RUN`);
      return { action, runRef };
    }
    case "stop-effect": {
      const runRef = positional(argv, "/flow stop-effect RUN OPERATION");
      const operationRef = positional(argv, "/flow stop-effect RUN OPERATION");
      exact(argv, "/flow stop-effect RUN OPERATION");
      return { action, runRef, operationRef };
    }
    case "respond":
      return parseRespond(argv);
    case "approve":
    case "reject":
      return parseDecision(action, argv);
    case "replay":
    case "fresh-run":
      return parseReplay(action, argv);
    case "drafts":
      return parseDrafts(argv);
    case "validate": {
      const draftId = positional(argv, "/flow validate user:NAME|project:NAME");
      exact(argv, "/flow validate user:NAME|project:NAME");
      return { action, draftId };
    }
    case "promote":
      return parsePromote(argv);
    case "discard-draft":
      return parseDiscard(argv);
    case "delete": {
      const runRef = positional(argv, "/flow delete RUN [--challenge HASH]");
      const challenge = oneOption(argv, "--challenge");
      return { action, runRef, ...(challenge ? { challenge } : {}) };
    }
    default:
      throw new Error(`Unknown /flow command: ${action}\n${flowHelpText()}`);
  }
}

export function flowHelpText(): string {
  return [
    "/flow list [--active] [--namespace builtin|user|project]",
    "/flow explain NAME",
    "/flow run NAME [--await|--async] [--args JSON]",
    "/flow status [RUN]",
    "/flow open RUN",
    "/flow pause RUN",
    "/flow resume RUN",
    "/flow stop RUN",
    "/flow stop-effect RUN OPERATION",
    "/flow respond RUN [CHECKPOINT] [--challenge HASH] [--value JSON_OR_CHOICE]",
    "/flow approve RUN [--challenge HASH]",
    "/flow reject RUN [--challenge HASH]",
    "/flow replay RUN [--await|--async] [--args JSON]",
    "/flow fresh-run RUN [--await|--async] [--args JSON]",
    "/flow drafts [user:NAME|project:NAME] [--namespace user|project]",
    "/flow validate user:NAME|project:NAME",
    "/flow promote user:NAME|project:NAME [--challenge HASH]",
    "/flow discard-draft user:NAME|project:NAME [--expected-hash HASH]",
    "/flow delete RUN [--challenge HASH]",
  ].join("\n");
}

function parseList(argv: string[]): FlowCommand {
  let activeOnly = false;
  let namespace: "builtin" | "user" | "project" | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--active" && !activeOnly) activeOnly = true;
    else if (option === "--namespace" && namespace === undefined) {
      const value = requireValue(argv, ++index, option);
      if (value !== "builtin" && value !== "user" && value !== "project") throw new Error("--namespace must be builtin, user, or project");
      namespace = value;
    } else throw new Error(`Unknown /flow list option: ${option}`);
  }
  return { action: "list", activeOnly, ...(namespace ? { namespace } : {}) };
}

function parseRun(argv: string[]): FlowCommand {
  const name = positional(argv, "/flow run NAME [--await|--async] [--args JSON]");
  const parsed = launchOptions(argv);
  return { action: "run", name, args: parsed.args ?? {}, mode: parsed.mode };
}

function parseReplay(action: "replay" | "fresh-run", argv: string[]): FlowCommand {
  const sourceRunRef = positional(argv, `/flow ${action} RUN [--await|--async] [--args JSON]`);
  const parsed = launchOptions(argv);
  return { action, sourceRunRef, ...(parsed.args ? { args: parsed.args } : {}), mode: parsed.mode };
}

function launchOptions(argv: string[]): { mode: "await" | "async"; args?: Record<string, unknown> } {
  let mode: "await" | "async" = "await";
  let modeSeen = false;
  let args: Record<string, unknown> | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--await" || option === "--async") {
      if (modeSeen) throw new Error("Use only one invocation mode");
      modeSeen = true;
      mode = option === "--await" ? "await" : "async";
    } else if (option === "--args" && args === undefined) {
      args = jsonObject(requireValue(argv, ++index, option), option);
    } else throw new Error(`Unknown workflow launch option: ${option}`);
  }
  return { mode, ...(args ? { args } : {}) };
}

function parseRespond(argv: string[]): FlowCommand {
  const runRef = positional(argv, "/flow respond RUN [CHECKPOINT] [--challenge HASH] [--value VALUE]");
  const checkpointId = argv[0] && !argv[0].startsWith("--") ? argv.shift() : undefined;
  let challenge: string | undefined;
  let value: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--challenge" && challenge === undefined) challenge = requireValue(argv, ++index, option);
    else if (option === "--value" && value === undefined) value = requireValue(argv, ++index, option);
    else throw new Error(`Unknown /flow respond option: ${option}`);
  }
  return { action: "respond", runRef, ...(checkpointId ? { checkpointId } : {}), ...(challenge ? { challenge } : {}), ...(value !== undefined ? { value } : {}) };
}

function parseDecision(action: "approve" | "reject", argv: string[]): FlowCommand {
  const runRef = positional(argv, `/flow ${action} RUN [--challenge HASH]`);
  const challenge = oneOption(argv, "--challenge");
  return { action, runRef, ...(challenge ? { challenge } : {}) };
}

function parseDrafts(argv: string[]): FlowCommand {
  const draftId = argv[0] && !argv[0].startsWith("--") ? argv.shift() : undefined;
  let namespace: "user" | "project" | undefined;
  if (argv.length) {
    if (argv.shift() !== "--namespace") throw new Error("Unknown /flow drafts option");
    const value = positional(argv, "/flow drafts [ID] [--namespace user|project]");
    if (value !== "user" && value !== "project") throw new Error("--namespace must be user or project");
    namespace = value;
  }
  exact(argv, "/flow drafts [ID] [--namespace user|project]");
  if (draftId && namespace) throw new Error("/flow drafts accepts either an id or a namespace filter");
  return { action: "drafts", ...(draftId ? { draftId } : {}), ...(namespace ? { namespace } : {}) };
}

function parsePromote(argv: string[]): FlowCommand {
  const draftId = positional(argv, "/flow promote ID [--challenge HASH]");
  const challenge = oneOption(argv, "--challenge");
  return { action: "promote", draftId, ...(challenge ? { challenge } : {}) };
}

function parseDiscard(argv: string[]): FlowCommand {
  const draftId = positional(argv, "/flow discard-draft ID [--expected-hash HASH]");
  const expectedHash = oneOption(argv, "--expected-hash");
  return { action: "discard-draft", draftId, ...(expectedHash ? { expectedHash } : {}) };
}

function oneOption(argv: string[], option: string): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== option) throw new Error(`Only ${option} is accepted here`);
  return argv[1]!;
}

function jsonObject(source: string, label: string): Record<string, unknown> {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function positional(argv: string[], usageText: string): string {
  const value = argv.shift();
  if (!value || value.startsWith("--")) throw usage(usageText);
  return value;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function exact(argv: string[], usageText: string): void { if (argv.length) throw usage(usageText); }
function usage(text: string): Error { return new Error(`Usage: ${text}`); }
