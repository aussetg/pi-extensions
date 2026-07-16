import * as fs from "node:fs";
import * as path from "node:path";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "../lsp/service.ts";
import { normalizeToolPath } from "../paths.ts";
import type { PiApi, PiCommandContext } from "../pi.ts";
import { renderFooterStatus } from "../render.ts";
import { addTrustedEnvironmentRoot, clearTrustedEnvironmentRoots, removeTrustedEnvironmentRoot, restartLsp, setProjectRoot, type CodeFeedbackRuntime } from "../runtime.ts";

const SUBCOMMANDS = ["status", "add", "remove", "clear", "help"] as const;
const TRUST_ENTRY_TYPE = "code-feedback-trust";
const TRUST_ENTRY_VERSION = 1;

export function trustArgumentCompletions(prefix: string): Array<{ value: string; label?: string }> {
  const needle = prefix.trim().toLowerCase();
  return SUBCOMMANDS
    .filter((command) => command.startsWith(needle))
    .map((command) => ({ value: command, label: command }));
}

export async function handleTrustCommand(
  pi: PiApi,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  args: unknown,
  ctx: PiCommandContext,
): Promise<void> {
  setProjectRoot(runtime, ctx.cwd);
  const parsed = parseTrustArgs(args);
  const subcommand = parsed.subcommand;

  switch (subcommand) {
    case "status":
      notify(ctx, renderTrustStatus(runtime), "info");
      return;

    case "add": {
      const root = resolveTrustRoot(parsed.path, ctx.cwd ?? runtime.projectRoot);
      if (!root.ok) {
        notify(ctx, root.error, "warning");
        return;
      }

      const changed = addTrustedEnvironmentRoot(runtime, root.path);
      if (changed) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, changed ? "trusted external root added" : undefined);
      setFooterStatus(ctx, runtime, lspService);
      notify(ctx, `${changed ? "Trusted" : "Already trusted"}: ${formatPath(runtime, root.path)}\n\n${renderTrustStatus(runtime)}`, "info");
      return;
    }

    case "remove": {
      const root = resolveTrustRoot(parsed.path, ctx.cwd ?? runtime.projectRoot, { mustExist: false });
      if (!root.ok) {
        notify(ctx, root.error, "warning");
        return;
      }

      const changed = removeTrustedEnvironmentRoot(runtime, root.path);
      if (changed) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, changed ? "trusted external root removed" : undefined);
      setFooterStatus(ctx, runtime, lspService);
      notify(ctx, `${changed ? "Removed trust" : "Not trusted"}: ${formatPath(runtime, root.path)}\n\n${renderTrustStatus(runtime)}`, changed ? "info" : "warning");
      return;
    }

    case "clear": {
      const count = clearTrustedEnvironmentRoots(runtime);
      if (count > 0) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, count > 0 ? "trusted external roots cleared" : undefined);
      setFooterStatus(ctx, runtime, lspService);
      notify(ctx, count > 0 ? `Cleared ${count} trusted external root${count === 1 ? "" : "s"}.` : "No trusted external roots to clear.", "info");
      return;
    }

    case "help":
    default:
      notify(ctx, renderTrustHelp(), subcommand === "help" ? "info" : "warning");
      return;
  }
}

export function restoreTrustedEnvironmentRoots(runtime: CodeFeedbackRuntime, ctx: PiCommandContext): boolean {
  const previous = [...runtime.trustedEnvironmentRoots];
  runtime.trustedEnvironmentRoots = readTrustedEnvironmentRoots(ctx)
    .map((root) => path.resolve(root))
    .filter(uniqueStrings)
    .sort((left, right) => left.localeCompare(right));
  return !stringArraysEqual(previous, runtime.trustedEnvironmentRoots);
}

export function persistTrustedEnvironmentRoots(pi: PiApi, runtime: CodeFeedbackRuntime): void {
  pi.appendEntry?.(TRUST_ENTRY_TYPE, {
    version: TRUST_ENTRY_VERSION,
    roots: [...runtime.trustedEnvironmentRoots],
  });
}

export async function reconfigureTrustedEnvironmentServices(
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  restartReason?: string,
): Promise<void> {
  await reconfigureAfterTrustChange(runtime, lspService, formatService, restartReason);
}

function parseTrustArgs(args: unknown): { subcommand: string; path?: string } {
  const values = normalizeArgs(args);
  const [first, ...rest] = values;
  if (!first) return { subcommand: "status" };
  const lower = first.toLowerCase();
  if (SUBCOMMANDS.includes(lower as (typeof SUBCOMMANDS)[number])) {
    return { subcommand: lower, path: rest.join(" ") || undefined };
  }
  return { subcommand: "add", path: values.join(" ") };
}

function normalizeArgs(args: unknown): string[] {
  if (Array.isArray(args)) {
    return args.filter((arg): arg is string => typeof arg === "string" && arg.length > 0);
  }
  if (typeof args === "string") {
    return args.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function readTrustedEnvironmentRoots(ctx: PiCommandContext): string[] {
  let roots: string[] = [];
  for (const entry of sessionBranch(ctx)) {
    if (!isTrustEntry(entry)) continue;
    roots = stringArray(entry.data?.roots);
  }
  return roots;
}

function sessionBranch(ctx: PiCommandContext): unknown[] {
  return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
}

function isTrustEntry(value: unknown): value is { data?: { roots?: unknown } } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { type?: unknown; customType?: unknown; data?: { version?: unknown; roots?: unknown } };
  return entry.type === "custom" && entry.customType === TRUST_ENTRY_TYPE && entry.data?.version === TRUST_ENTRY_VERSION;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function uniqueStrings(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveTrustRoot(rawPath: string | undefined, cwd: string, options: { mustExist?: boolean } = {}): { ok: true; path: string } | { ok: false; error: string } {
  const mustExist = options.mustExist ?? true;
  const normalized = rawPath ? normalizeToolPath(rawPath.trim()) : "";
  if (!normalized) return { ok: false, error: "Usage: /lsp trust add <path>" };

  const resolved = path.resolve(cwd, normalized);
  const stat = statIfExists(resolved);
  if (!stat) {
    return mustExist ? { ok: false, error: `Cannot trust missing path: ${resolved}` } : { ok: true, path: resolved };
  }
  if (stat.isDirectory()) return { ok: true, path: resolved };
  if (stat.isFile()) return { ok: true, path: path.dirname(resolved) };
  return { ok: false, error: `Cannot trust non-file, non-directory path: ${resolved}` };
}

async function reconfigureAfterTrustChange(
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  restartReason: string | undefined,
): Promise<void> {
  if (restartReason) {
    restartLsp(runtime, restartReason);
    await lspService.restart();
  }
  lspService.configure({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
    idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
  });
  formatService.configure({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
  });
}

function renderTrustStatus(runtime: CodeFeedbackRuntime): string {
  const lines = [
    "code-feedback / trusted roots",
    `  project root: ${runtime.projectRoot} (${runtime.projectTrusted ? "trusted" : "not trusted by Pi project trust"})`,
  ];
  if (runtime.trustedEnvironmentRoots.length === 0) {
    lines.push("  external roots: none");
  } else {
    lines.push("  external roots:");
    for (const root of runtime.trustedEnvironmentRoots) lines.push(`    ${formatPath(runtime, root)}`);
  }
  lines.push("", "The inherited process PATH is trusted. External roots extend environment discovery and act as workspaces for files inside them.");
  return lines.join("\n");
}

function renderTrustHelp(): string {
  return [
    "code-feedback / trust command",
    "",
    "Usage:",
    "  /lsp trust status",
    "  /lsp trust <path>",
    "  /lsp trust add <path>",
    "  /lsp trust remove <path>",
    "  /lsp trust clear",
  ].join("\n");
}

function formatPath(runtime: CodeFeedbackRuntime, filePath: string): string {
  const relative = path.relative(runtime.projectRoot, filePath);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative;
}

function notify(ctx: PiCommandContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, level);
}

function setFooterStatus(ctx: PiCommandContext, runtime: CodeFeedbackRuntime, lspService: LspService): void {
  ctx.ui.setStatus?.("code-feedback-lsp", renderFooterStatus(runtime, ctx.ui.theme, lspService.getStatus()));
}

function statIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}
