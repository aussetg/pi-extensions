import * as path from "node:path";
import { formatTouchedRange } from "./diagnostics/ranges.ts";
import type { CodeFeedbackRuntime } from "./runtime.ts";
import type { CodeFeedbackTiming, CompletedEdit, DelayedDiagnosticFeedback, DiagnosticFilterResult, DiagnosticSeverity, DiagnosticSnapshot, FormatServiceStatus, FormatterSummary, LinkedDiagnostic, LspDiagnostic, LspServiceStatus } from "./types.ts";

export interface FooterTheme {
  fg?: (color: string, text: string) => string;
}

export function renderStatus(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, formatStatus?: FormatServiceStatus): string {
  const config = runtime.config;
  const activeClients = lspStatus?.activeClients ?? 0;
  const lines = [
    "pi-code-feedback / LSP status",
    `  extension: ${config.enabled ? "enabled" : "disabled"}`,
    `  lsp feedback: ${config.lsp.enabled ? "enabled" : "disabled"}`,
    `  inline diagnostics: ${config.diagnostics.inline}`,
    `  auto format: ${config.autoFormat ? config.formatMode : "disabled"}`,
    `  strict: ${config.strict ? "enabled" : "disabled"}`,
    `  project root: ${runtime.projectRoot}`,
    `  active LSP clients: ${activeClients}`,
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

  const recentTimedEdits = runtime.completedEdits.filter((edit) => edit.timing).slice(-5).reverse();
  if (recentTimedEdits.length > 0) {
    lines.push("", "  recent edit timings:");
    for (const edit of recentTimedEdits) {
      const relative = path.relative(runtime.projectRoot, edit.filePath) || edit.filePath;
      lines.push(`    ${relative}: ${formatTimingSummary(edit.timing!)}`);
    }
  }

  if (lspStatus && lspStatus.clients.length > 0) {
    lines.push("", "  clients:");
    for (const client of lspStatus.clients) {
      const pid = client.pid ? ` pid=${client.pid}` : "";
      const last = client.lastDiagnosticsAt ? ` last_diag=${formatTimestamp(client.lastDiagnosticsAt)}` : "";
      lines.push(`    ${client.id}: ${client.state}${pid} docs=${client.openDocuments} diag_files=${client.diagnosticFiles}${last}`);
      if (client.lastError) lines.push(`      error: ${client.lastError}`);
      if (client.lastServerLog) lines.push(`      server ${client.lastServerLog.level}: ${client.lastServerLog.message}`);
    }
  }

  if (lspStatus && lspStatus.unavailableServers.length > 0) {
    lines.push("", "  unavailable:");
    for (const unavailable of lspStatus.unavailableServers) {
      const relative = path.relative(runtime.projectRoot, unavailable.filePath) || unavailable.filePath;
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
        const relative = path.relative(runtime.projectRoot, run.filePath) || run.filePath;
        const formatter = run.formatterName ?? "formatter";
        const outcome = run.errors.length > 0 ? "failed" : run.changed ? "changed" : "unchanged";
        lines.push(`      ${relative}: ${formatter} ${outcome}${run.durationMs === undefined ? "" : ` (${run.durationMs}ms)`}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderCapabilities(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, capabilities?: unknown): string {
  const lines = [
    "pi-code-feedback / LSP capabilities",
    `  lsp feedback: ${runtime.config.lsp.enabled ? "enabled" : "disabled"}`,
    `  active servers: ${lspStatus?.activeClients ?? 0}`,
    "  implemented: diagnostics, hover, definition, references, implementation, type_definition, symbols, workspace_symbols, code_actions, rename, capabilities, reload, request",
  ];

  if (lspStatus && lspStatus.clients.length > 0) {
    lines.push("", "  clients:");
    for (const client of lspStatus.clients) {
      lines.push(`    ${client.id}: ${client.state} ${client.command} ${client.args.join(" ")}`.trimEnd());
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
    `  cached LSP diagnostics: ${snapshot ? countSnapshotDiagnostics(snapshot) : 0}`,
  ];

  if (snapshot && countSnapshotDiagnostics(snapshot) > 0) {
    lines.push("", "  cached diagnostics:");
    for (const diagnostic of flattenSnapshot(snapshot).slice(0, 30)) {
      lines.push(...formatDiagnostic(runtime.projectRoot, diagnostic, 4));
    }
    const hidden = countSnapshotDiagnostics(snapshot) - 30;
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
    const relative = path.relative(runtime.projectRoot, edit.filePath) || edit.filePath;
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
    if (edit.timing) {
      lines.push(`      timing: ${formatTimingSummary(edit.timing)}`);
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

  const relative = path.relative(runtime.projectRoot, edit.filePath) || edit.filePath;
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

export function renderFooterStatus(runtime: CodeFeedbackRuntime, theme?: FooterTheme): string {
  const text = runtime.config.enabled && runtime.config.lsp.enabled ? "lsp:on" : "lsp:off";
  return theme?.fg?.("dim", text) ?? text;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function flattenSnapshot(snapshot: DiagnosticSnapshot): LspDiagnostic[] {
  return [...snapshot.byUri.values()].flat();
}

function countSnapshotDiagnostics(snapshot: DiagnosticSnapshot): number {
  let count = 0;
  for (const diagnostics of snapshot.byUri.values()) count += diagnostics.length;
  return count;
}

function formatDiagnostic(projectRoot: string, diagnostic: LspDiagnostic, indentColumns: number): string[] {
  const filePath = filePathFromUri(diagnostic.uri);
  const displayPath = filePath ? path.relative(projectRoot, filePath) || filePath : diagnostic.uri;
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
  const displayPath = filePath ? path.relative(projectRoot, filePath) || filePath : diagnostic.uri;
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
    const target = projectRoot && filePath ? ` ${path.relative(projectRoot, filePath) || filePath}` : " file";
    parts.push(`formatted:${target} with ${name}`);
  }
  if (formatter.errors.length > 0) {
    const first = formatter.errors[0].split("\n").slice(0, 4).join("\n    ");
    parts.push(`format failed: ${name}: ${first}`);
  }
  return parts.join("; ");
}

function formatTimingSummary(timing: CodeFeedbackTiming): string {
  const slowPhases = timing.phases
    .filter((phase) => phase.durationMs >= 0.05)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 4)
    .map((phase) => `${formatTimingPhaseName(phase.name)} ${formatDurationMs(phase.durationMs)}`);
  return `total ${formatDurationMs(timing.totalMs)}${slowPhases.length > 0 ? ` (${slowPhases.join(", ")})` : ""}`;
}

function formatTimingPhaseName(name: string): string {
  return name.replace(/^tool_(call|result)\./, "").replace(/^delayed\./, "delayed ").replace(/_/g, " ");
}

function formatDurationMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
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

