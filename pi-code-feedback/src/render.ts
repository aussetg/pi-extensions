import * as path from "node:path";
import { formatTouchedRange } from "./diagnostics/ranges.ts";
import { countDiagnosticSnapshotDiagnostics, flattenDiagnosticSnapshot } from "./diagnostics/snapshots.ts";
import { displayPathFromRoot } from "./paths.ts";
import type { CodeFeedbackRuntime } from "./runtime.ts";
import { LSP_METHODS, type CompletedEdit, type DelayedDiagnosticFeedback, type DiagnosticFilterResult, type DiagnosticSeverity, type DiagnosticSnapshot, type FormatServiceStatus, type FormatterSummary, type LinkedDiagnostic, type LspDiagnostic, type LspServiceStatus } from "./types.ts";

export interface FooterTheme {
  fg?: (color: string, text: string) => string;
}

export function renderStatus(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, formatStatus?: FormatServiceStatus): string {
  const config = runtime.config;
  const lines = [
    "pi-code-feedback / LSP status",
    `  extension: ${config.enabled ? "enabled" : "disabled"}`,
    `  lsp feedback: ${config.lsp.enabled ? "enabled" : "disabled"}`,
    `  inline diagnostics: ${config.diagnostics.inline}`,
    `  auto format: ${config.autoFormat ? config.formatMode : "disabled"}`,
    `  strict: ${config.strict ? "enabled" : "disabled"}`,
    `  project root: ${runtime.projectRoot}`,
    `  trusted external roots: ${formatTrustedEnvironmentRoots(runtime)}`,
    `  clients: ${formatClientSummary(lspStatus)}`,
    `  lsp restarts: ${runtime.lspRestartCount}`,
    `  captured edits: ${runtime.completedEdits.length}`,
    `  pending edits: ${runtime.pendingEdits.size}`,
    `  delayed feedback queued: ${runtime.delayedFeedback.length}`,
  ];

  if (runtime.lastLspRestartAt) {
    lines.push(`  last restart: ${formatTimestamp(runtime.lastLspRestartAt)} (${runtime.lastReloadReason ?? "manual"})`);
  }
  if (runtime.lastError) {
    lines.push(`  last error: ${runtime.lastError}`);
  }

  if (lspStatus && lspStatus.clients.length > 0) {
    lines.push("", "  clients:");
    for (const client of lspStatus.clients) {
      const pid = client.pid ? ` pid=${client.pid}` : "";
      const last = client.lastDiagnosticsAt ? ` last_diag=${formatTimestamp(client.lastDiagnosticsAt)}` : "";
      const latency = formatClientDiagnosticLatency(client);
      const environment = client.environment ? ` env=${client.environment}` : "";
      lines.push(`    ${client.id}: ${client.state}${pid} docs=${client.openDocuments} diag_files=${client.diagnosticFiles}${environment}${last}${latency ? ` diag_latency=${latency}` : ""}`);
      if (client.lastError) lines.push(`      error: ${client.lastError}`);
      if (client.lastServerLog) lines.push(`      server ${client.lastServerLog.level}: ${client.lastServerLog.message}`);
    }
  }

  if (lspStatus && lspStatus.unavailableServers.length > 0) {
    lines.push("", "  unavailable:");
    for (const unavailable of lspStatus.unavailableServers) {
      const relative = displayPathFromRoot(unavailable.filePath, runtime.projectRoot);
      lines.push(`    ${unavailable.id}: ${unavailable.reason} (${relative})`);
    }
  }

  if (formatStatus) {
    lines.push("", "  formatters:");
    const available = formatStatus.commands.filter((command) => command.available).map((command) => command.id).join(", ") || "none found";
    lines.push(`    available commands: ${available}`);

    const recentRuns = formatStatus.recentRuns.filter((run) => run.changed || run.errors.length > 0).slice(0, 5);
    if (recentRuns.length > 0) {
      lines.push("    recent changes/errors:");
      for (const run of recentRuns) {
        const relative = displayPathFromRoot(run.filePath, runtime.projectRoot);
        const formatter = run.formatterName ?? "formatter";
        const outcome = run.errors.length > 0 ? "failed" : run.changed ? "changed" : "unchanged";
        lines.push(`      ${relative}: ${formatter} ${outcome}${run.durationMs === undefined ? "" : ` (${run.durationMs}ms)`}`);
      }
    }
  }

  return lines.join("\n");
}

function formatTrustedEnvironmentRoots(runtime: CodeFeedbackRuntime): string {
  if (runtime.trustedEnvironmentRoots.length === 0) return "none";
  return runtime.trustedEnvironmentRoots
    .map((root) => {
      const relative = path.relative(runtime.projectRoot, root);
      return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? root : relative;
    })
    .join(", ");
}

export function renderCapabilities(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, capabilities?: unknown): string {
  const lines = [
    "pi-code-feedback / LSP capabilities",
    `  lsp feedback: ${runtime.config.lsp.enabled ? "enabled" : "disabled"}`,
    `  clients: ${formatClientSummary(lspStatus)}`,
    `  implemented: ${LSP_METHODS.join(", ")}`,
  ];

  if (lspStatus && lspStatus.clients.length > 0) {
    lines.push("", "  clients:");
    for (const client of lspStatus.clients) {
      const environment = client.environment ? ` [${client.environment}]` : "";
      lines.push(`    ${client.id}: ${client.state} ${client.command} ${client.args.join(" ")}${environment}`.trimEnd());
    }
  }

  if (capabilities !== undefined) {
    lines.push("", "  selected capabilities:", indent(truncateJson(capabilities, 5000), 4));
  }

  return lines.join("\n");
}

export function renderDiagnosticsStatus(runtime: CodeFeedbackRuntime, target?: string, snapshot?: DiagnosticSnapshot): string {
  const targetPath = target && target !== "all" ? path.resolve(runtime.projectRoot, target) : undefined;
  const lines = [
    "pi-code-feedback / diagnostics",
    `  target: ${target ?? "current session"}`,
    `  known LSP diagnostics: ${snapshot ? countDiagnosticSnapshotDiagnostics(snapshot) : 0}`,
  ];

  if (snapshot && countDiagnosticSnapshotDiagnostics(snapshot) > 0) {
    lines.push("", "  diagnostics:");
    for (const diagnostic of flattenDiagnosticSnapshot(snapshot).slice(0, 30)) {
      lines.push(...formatDiagnostic(runtime.projectRoot, diagnostic, 4));
    }
    const hidden = countDiagnosticSnapshotDiagnostics(snapshot) - 30;
    if (hidden > 0) lines.push(`    ... ${hidden} more`);
  }

  const recent = runtime.completedEdits
    .filter((edit) => !targetPath || path.resolve(edit.filePath) === targetPath)
    .slice(-5)
    .reverse();
  if (recent.length === 0) {
    lines.push("  touched ranges: none captured yet");
    return lines.join("\n");
  }

  lines.push("", "  recent touched ranges:");
  for (const edit of recent) {
    const relative = displayPathFromRoot(edit.filePath, runtime.projectRoot);
    const ranges = edit.skippedReason
      ? edit.skippedReason
      : edit.touchedRanges.length > 0
      ? edit.touchedRanges.map(formatTouchedRange).join(", ")
      : "none";
    const diffSource = edit.skippedReason ?? (edit.detailsDiffPresent ? "tool diff" : "content diff");
    const operation = edit.applyPatchOperationIndex === undefined ? "" : ` op#${edit.applyPatchOperationIndex + 1}`;
    lines.push(`    ${relative}: ${ranges} [${edit.toolName}${operation}, ${diffSource}]`);
    if (edit.formatter?.changed || edit.formatter?.errors.length) {
      lines.push(`      ${formatFormatterSummary(edit.formatter)}`);
    }
    if (edit.diagnosticFilter) {
      const summary = edit.diagnosticFilter.summary;
      lines.push(`      diagnostics: ${summary.shownDiagnostics}/${summary.linkedDiagnostics} linked shown, ${summary.hiddenUnrelated} unrelated hidden`);
    }
  }

  return lines.join("\n");
}

export function renderInlineDiagnosticFeedback(runtime: CodeFeedbackRuntime, edit: CompletedEdit): string | undefined {
  const filter = edit.diagnosticFilter;
  const hasLinkedDiagnostics = Boolean(filter && filter.linked.length > 0);
  const hasFormatterFeedback = Boolean(edit.formatter?.changed || edit.formatter?.errors.length);
  if (!hasLinkedDiagnostics && !hasFormatterFeedback) return undefined;

  const lines = ["pi-code-feedback:"];

  if (edit.formatter?.changed || edit.formatter?.errors.length) {
    lines.push(`  ${formatFormatterSummary(edit.formatter, runtime.projectRoot, edit.filePath)}`);
  }

  if (filter && filter.linked.length > 0) {
    const severityCounts = countSeverities(filter.linked);
    const label = runtime.config.diagnostics.inline === "all" ? "diagnostics" : "touched diagnostics";
    lines.push(`  ${label}: ${formatSeverityCounts(severityCounts)}`);

    for (const linked of filter.linked) {
      lines.push("", ...formatLinkedDiagnostic(runtime.projectRoot, linked));
    }

    const hiddenText = formatHiddenDiagnostics(filter);
    if (hiddenText) lines.push("", `  hidden: ${hiddenText}`);
  }

  return lines.join("\n");
}

export function renderDelayedDiagnosticFeedback(runtime: CodeFeedbackRuntime, edit: CompletedEdit): string | undefined {
  const filter = edit.diagnosticFilter;
  if (!filter || filter.linked.length === 0) return undefined;

  const relative = displayPathFromRoot(edit.filePath, runtime.projectRoot);
  const severityCounts = countSeverities(filter.linked);
  const scope = runtime.config.diagnostics.inline === "all" ? "all files" : relative;
  const lines = [
    "pi-code-feedback delayed LSP diagnostics:",
    `  ${scope}: ${formatSeverityCounts(severityCounts)}`,
  ];

  for (const linked of filter.linked) {
    lines.push("", ...formatLinkedDiagnostic(runtime.projectRoot, linked));
  }

  const hiddenText = formatHiddenDiagnostics(filter);
  if (hiddenText) lines.push("", `  hidden: ${hiddenText}`);
  return lines.join("\n");
}

export function renderDelayedContextMessage(feedback: DelayedDiagnosticFeedback[]): string {
  const blocks = feedback.map((entry) => entry.text.trim()).filter(Boolean);
  const prefix = [
    "Delayed pi-code-feedback LSP feedback arrived after the previous tool-result timeout.",
    "Treat it as follow-up diagnostics for edits you already made:",
  ].join("\n");
  return [prefix, ...blocks].join("\n\n");
}

export function renderFooterStatus(runtime: CodeFeedbackRuntime, theme?: FooterTheme, lspStatus?: LspServiceStatus): string {
  const text = footerStatusText(runtime, lspStatus);
  return theme?.fg?.("dim", text) ?? text;
}

function footerStatusText(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus): string {
  const trusted = formatFooterTrustedRoots(runtime);
  if (!runtime.config.enabled || !runtime.config.lsp.enabled) return `lsp: off${trusted}`;

  const clients = (lspStatus?.clients ?? [])
    .filter((client) => client.state === "ready" || client.state === "starting")
    .sort(compareFooterClients);
  if (clients.length === 0) return `lsp: idle${trusted}`;

  const shown = clients.slice(0, 4).map(formatFooterClient);
  const hidden = clients.length - shown.length;
  return `lsp: ${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}${trusted}`;
}

function formatFooterTrustedRoots(runtime: CodeFeedbackRuntime): string {
  if (runtime.trustedEnvironmentRoots.length === 0) return "";
  const shown = runtime.trustedEnvironmentRoots.slice(0, 3);
  const hidden = runtime.trustedEnvironmentRoots.length - shown.length;
  return ` trusted: ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

function formatClientSummary(lspStatus?: LspServiceStatus): string {
  if (!lspStatus) return "unknown";
  if (lspStatus.clients.length === 0) return "none yet — starts lazily when you query a source file";

  const counts = new Map<string, number>();
  for (const client of lspStatus.clients) {
    counts.set(client.state, (counts.get(client.state) ?? 0) + 1);
  }
  const ordered = ["ready", "starting", "failed", "stopped"]
    .map((state) => [state, counts.get(state) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  return `${lspStatus.clients.length} total${ordered ? ` (${ordered})` : ""}`;
}

function formatFooterClient(client: LspServiceStatus["clients"][number]): string {
  const label = footerClientLabel(client);
  const latency = formatClientDiagnosticLatency(client);
  const state = client.state === "starting" ? " starting" : "";
  return `${label}${latency ? ` (${latency})` : state}`;
}

function footerClientLabel(client: LspServiceStatus["clients"][number]): string {
  const commandName = path.basename(client.command);
  if (commandName === "ty" || commandName === "ruff") return commandName;
  if (client.id === "python-ruff") return "ruff";
  if (client.id === "python" && commandName === "ty") return "ty";
  return client.id;
}

function compareFooterClients(left: LspServiceStatus["clients"][number], right: LspServiceStatus["clients"][number]): number {
  return footerClientLabel(left).localeCompare(footerClientLabel(right));
}

function formatClientDiagnosticLatency(client: LspServiceStatus["clients"][number]): string | undefined {
  if (client.lastDiagnosticDurationMs === undefined) return undefined;
  const duration = `${Math.max(0, Math.round(client.lastDiagnosticDurationMs))} ms`;
  return client.lastDiagnosticTimedOut ? `timeout ${duration}` : duration;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDiagnostic(projectRoot: string, diagnostic: LspDiagnostic, indentColumns: number): string[] {
  const filePath = filePathFromUri(diagnostic.uri);
  const displayPath = filePath ? displayPathFromRoot(filePath, projectRoot) : diagnostic.uri;
  const sourceCode = [diagnostic.source, diagnostic.code].filter((part) => part !== undefined && part !== "").join("/");
  const suffix = sourceCode ? ` ${sourceCode}` : "";
  const prefix = " ".repeat(indentColumns);
  return [
    `${prefix}${diagnostic.severity.toUpperCase()} ${displayPath}:${diagnostic.range.start.line}:${diagnostic.range.start.character}${suffix}`,
    `${prefix}  ${diagnostic.message}`,
  ];
}

function truncateJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... truncated`;
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatLinkedDiagnostic(projectRoot: string, linked: LinkedDiagnostic): string[] {
  const diagnostic = linked.diagnostic;
  const filePath = filePathFromUri(diagnostic.uri);
  const displayPath = filePath ? displayPathFromRoot(filePath, projectRoot) : diagnostic.uri;
  const sourceCode = [diagnostic.source, diagnostic.code].filter((part) => part !== undefined && part !== "").join("/");
  const location = `${displayPath}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`;
  const reason = linked.linkReason === "overlap" ? "" : ` [${linked.linkReason}]`;
  const suffix = sourceCode ? ` ${sourceCode}` : "";

  return [
    `  ${diagnostic.severity.toUpperCase()} ${location}${suffix}${reason}`,
    `    ${diagnostic.message}`,
  ];
}

function formatHiddenDiagnostics(filter: DiagnosticFilterResult): string | undefined {
  const parts: string[] = [];
  if (filter.summary.hiddenUnrelated > 0) {
    parts.push(`${filter.summary.hiddenUnrelated} unrelated`);
  }
  if (filter.summary.hiddenByLimit > 0) {
    parts.push(`${filter.summary.hiddenByLimit} linked beyond inline limit`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatFormatterSummary(formatter: FormatterSummary, projectRoot?: string, filePath?: string): string {
  const name = formatter.formatterName ?? "formatter";
  const parts: string[] = [];
  if (formatter.changed) {
    const target = projectRoot && filePath ? ` ${displayPathFromRoot(filePath, projectRoot)}` : " file";
    parts.push(`formatted:${target} with ${name}`);
  }
  if (formatter.errors.length > 0) {
    const first = formatter.errors[0].split("\n").slice(0, 4).join("\n    ");
    parts.push(`format failed: ${name}: ${first}`);
  }
  return parts.join("; ");
}

function countSeverities(diagnostics: LinkedDiagnostic[]): Record<DiagnosticSeverity, number> {
  return diagnostics.reduce<Record<DiagnosticSeverity, number>>(
    (counts, linked) => {
      counts[linked.diagnostic.severity] += 1;
      return counts;
    },
    { error: 0, warning: 0, information: 0, hint: 0 },
  );
}

function formatSeverityCounts(counts: Record<DiagnosticSeverity, number>): string {
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  if (counts.information > 0) parts.push(`${counts.information} info`);
  if (counts.hint > 0) parts.push(`${counts.hint} hint${counts.hint === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function filePathFromUri(uri: string): string | undefined {
  try {
    if (!uri.startsWith("file:")) return undefined;
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

