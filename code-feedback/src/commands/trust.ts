import * as path from "node:path";
import type { FormatService } from "../format/service.ts";
import { statIfExists } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { displayPathFromRoot, normalizeToolPath } from "../paths.ts";
import type { PiApi, PiCommandContext } from "../pi.ts";
import { updateFooterStatus } from "../render.ts";
import { addTrustedEnvironmentRoot, clearTrustedEnvironmentRoots, configureFeedbackServices, removeTrustedEnvironmentRoot, restartLsp, setProjectRoot, type CodeFeedbackRuntime } from "../runtime.ts";
import { isRecord } from "../types.ts";

export const TRUST_SUBCOMMANDS = ["status", "add", "remove", "clear", "help"] as const;
const TRUST_ENTRY_TYPE = "code-feedback-trust";
const TRUST_ENTRY_VERSION = 1;

export async function handleTrustCommand(
  pi: PiApi,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  args: readonly string[],
  ctx: PiCommandContext,
): Promise<void> {
  setProjectRoot(runtime, ctx.cwd);
  const parsed = parseTrustArgs(args);
  const subcommand = parsed.subcommand;

  switch (subcommand) {
    case "status":
      ctx.ui.notify(renderTrustStatus(runtime), "info");
      return;

    case "add": {
      const root = resolveTrustRoot(parsed.path, ctx.cwd);
      if (!root.ok) {
        ctx.ui.notify(root.error, "warning");
        return;
      }

      const changed = addTrustedEnvironmentRoot(runtime, root.path);
      if (changed) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, changed ? "trusted external root added" : undefined);
      updateFooterStatus(ctx, runtime, lspService.getStatus());
      ctx.ui.notify(`${changed ? "Trusted" : "Already trusted"}: ${displayPathFromRoot(root.path, runtime.projectRoot)}\n\n${renderTrustStatus(runtime)}`, "info");
      return;
    }

    case "remove": {
      const root = resolveTrustRoot(parsed.path, ctx.cwd, { mustExist: false });
      if (!root.ok) {
        ctx.ui.notify(root.error, "warning");
        return;
      }

      const changed = removeTrustedEnvironmentRoot(runtime, root.path);
      if (changed) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, changed ? "trusted external root removed" : undefined);
      updateFooterStatus(ctx, runtime, lspService.getStatus());
      ctx.ui.notify(`${changed ? "Removed trust" : "Not trusted"}: ${displayPathFromRoot(root.path, runtime.projectRoot)}\n\n${renderTrustStatus(runtime)}`, changed ? "info" : "warning");
      return;
    }

    case "clear": {
      const count = clearTrustedEnvironmentRoots(runtime);
      if (count > 0) persistTrustedEnvironmentRoots(pi, runtime);
      await reconfigureAfterTrustChange(runtime, lspService, formatService, count > 0 ? "trusted external roots cleared" : undefined);
      updateFooterStatus(ctx, runtime, lspService.getStatus());
      ctx.ui.notify(count > 0 ? `Cleared ${count} trusted external root${count === 1 ? "" : "s"}.` : "No trusted external roots to clear.", "info");
      return;
    }

    case "help":
    default:
      ctx.ui.notify(renderTrustHelp(), subcommand === "help" ? "info" : "warning");
      return;
  }
}

export function restoreTrustedEnvironmentRoots(runtime: CodeFeedbackRuntime, ctx: PiCommandContext): boolean {
  const previous = [...runtime.trustedEnvironmentRoots];
  let roots: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (isTrustEntry(entry)) roots = Array.isArray(entry.data?.roots)
      ? entry.data.roots.filter((root): root is string => typeof root === "string" && root.length > 0)
      : [];
  }
  runtime.trustedEnvironmentRoots = [...new Set(roots.map((root) => path.resolve(root)))]
    .sort((left, right) => left.localeCompare(right));
  return previous.length !== runtime.trustedEnvironmentRoots.length ||
    previous.some((root, index) => root !== runtime.trustedEnvironmentRoots[index]);
}

export function persistTrustedEnvironmentRoots(pi: PiApi, runtime: CodeFeedbackRuntime): void {
  pi.appendEntry(TRUST_ENTRY_TYPE, {
    version: TRUST_ENTRY_VERSION,
    roots: [...runtime.trustedEnvironmentRoots],
  });
}

function parseTrustArgs(args: readonly string[]): { subcommand: string; path?: string } {
  const [first, ...rest] = args;
  if (!first) return { subcommand: "status" };
  const lower = first.toLowerCase();
  if (TRUST_SUBCOMMANDS.includes(lower as (typeof TRUST_SUBCOMMANDS)[number])) {
    return { subcommand: lower, path: rest.join(" ") || undefined };
  }
  return { subcommand: "add", path: [first, ...rest].join(" ") };
}

function isTrustEntry(value: unknown): value is { data?: { roots?: unknown } } {
  return isRecord(value) &&
    value.type === "custom" &&
    value.customType === TRUST_ENTRY_TYPE &&
    isRecord(value.data) &&
    value.data.version === TRUST_ENTRY_VERSION;
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

export async function reconfigureAfterTrustChange(
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  restartReason: string | undefined,
): Promise<void> {
  if (restartReason) {
    restartLsp(runtime, restartReason);
    await lspService.restart();
  }
  configureFeedbackServices(runtime, lspService, formatService);
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
    for (const root of runtime.trustedEnvironmentRoots) lines.push(`    ${displayPathFromRoot(root, runtime.projectRoot)}`);
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
