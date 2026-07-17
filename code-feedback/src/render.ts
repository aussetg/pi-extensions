import * as path from "node:path";
import { formatTouchedRange } from "./diagnostics/ranges.ts";
import { countDiagnosticSnapshotDiagnostics, flattenDiagnosticSnapshot } from "./diagnostics/snapshots.ts";
import { formatBytes } from "./fs.ts";
import { uriToFilePath } from "./lsp/positions.ts";
import { displayPathFromRoot, projectRelativeText } from "./paths.ts";
import type { PiCommandContext } from "./pi.ts";
import type { CodeFeedbackRuntime } from "./runtime.ts";
import { LSP_METHODS, type CompletedEdit, type DelayedDiagnosticFeedback, type DiagnosticFilterResult, type DiagnosticSeverity, type DiagnosticSnapshot, type FormatServiceStatus, type FormatterSummary, type LinkedDiagnostic, type LspDiagnostic, type LspServiceStatus, type TouchedRangeComputation, type WorkspaceDiagnosticDelta, type WorkspaceDiagnosticScanResult } from "./types.ts";

export interface ExplicitDiagnosticRefreshStatus {
  outcome: "fresh" | "eventual" | "timed-out" | "unavailable";
  durationMs?: number;
}

export function updateFooterStatus(
  ctx: PiCommandContext,
  runtime: CodeFeedbackRuntime,
  lspStatus: LspServiceStatus,
): void {
  ctx.ui.setStatus("code-feedback-lsp", renderFooterStatus(runtime, ctx.ui.theme, lspStatus));
}

export interface FooterTheme {
  fg(color: string, text: string): string;
}

export function renderStatus(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, formatStatus?: FormatServiceStatus): string {
  const config = runtime.config;
  const lines = [
    "code-feedback / LSP status",
    `  extension: ${config.enabled ? "enabled" : "disabled"}`,
    `  lsp feedback: ${config.lsp.enabled ? "enabled" : "disabled"}`,
    `  lsp client budget: ${formatClientResourceSummary(lspStatus, config.lsp.maxActiveClients, config.lsp.initializationConcurrency)}`,
    `  diagnostic refresh concurrency: ${config.lsp.diagnosticRefreshConcurrency}${formatDiagnosticRefreshSummary(lspStatus)}`,
    `  inline diagnostics: ${config.diagnostics.inline}`,
    `  auto format: ${config.autoFormat ? "immediate" : "disabled"}`,
    `  delayed context injection: ${config.contextInjection ? "enabled" : "disabled"}`,
    `  strict: ${config.strict ? "enabled" : "disabled"}`,
    `  project trust: ${runtime.projectTrusted ? "trusted" : "not trusted — LSP/formatting paused"}`,
    `  project root: ${runtime.projectRoot}`,
    `  trusted external roots: ${formatTrustedEnvironmentRoots(runtime)}`,
    ...formatServerConfigurationSummary(lspStatus),
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
      const root = displayPathFromRoot(client.root, runtime.projectRoot);
      const busy = client.busy ? " busy" : "";
      lines.push(`    ${client.id}: ${client.state}${busy} role=${client.role} root=${root}${pid} docs=${client.openDocuments} diag_files=${client.diagnosticFiles}${environment}${last}${latency ? ` diag_latency=${latency}` : ""}`);
      if (client.lastError) lines.push(`      error: ${client.lastError}`);
      if (client.initializationRetryAt && client.initializationRetryAt > Date.now()) {
        lines.push(`      initialization retry after: ${formatTimestamp(client.initializationRetryAt)}`);
      }
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

  if (lspStatus?.serverConfiguration && lspStatus.serverConfiguration.errors.length > 0) {
    lines.push("", "  server config errors:");
    for (const error of lspStatus.serverConfiguration.errors) lines.push(`    ${error}`);
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

function formatServerConfigurationSummary(lspStatus?: LspServiceStatus): string[] {
  const configuration = lspStatus?.serverConfiguration;
  if (!configuration) return [];
  const sources = configuration.sources
    .map((source) => `${source.scope}=${source.state}`)
    .join(", ");
  const configured = configuration.configuredServerIds.join(", ") || "built-ins only";
  return [
    `  server config: ${sources || "not loaded"}`,
    `  configured server entries: ${configured}`,
  ];
}

export function renderCapabilities(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus, capabilities?: unknown): string {
  const lines = [
    "code-feedback / LSP capabilities",
    `  lsp feedback: ${runtime.config.lsp.enabled ? "enabled" : "disabled"}`,
    `  clients: ${formatClientSummary(lspStatus)}`,
    `  implemented: ${LSP_METHODS.join(", ")}`,
  ];

  if (lspStatus && lspStatus.clients.length > 0) {
    lines.push("", "  clients:");
    for (const client of lspStatus.clients) {
      const environment = client.environment ? ` [${client.environment}]` : "";
      const root = displayPathFromRoot(client.root, runtime.projectRoot);
      lines.push(`    ${client.id}: ${client.state} role=${client.role} root=${root} ${client.command} ${client.args.join(" ")}${environment}`.trimEnd());
    }
  }

  if (capabilities !== undefined) {
    lines.push("", "  selected capabilities:", indent(truncateJson(capabilities, 5000), 4));
  }

  return lines.join("\n");
}

export function renderDiagnosticsStatus(
  runtime: CodeFeedbackRuntime,
  target?: string,
  snapshot?: DiagnosticSnapshot,
  workspaceScan?: WorkspaceDiagnosticScanResult,
  refresh?: ExplicitDiagnosticRefreshStatus,
): string {
  const targetPath = target && target !== "all" ? path.resolve(runtime.projectRoot, target) : undefined;
  const lines = [
    "code-feedback / diagnostics",
    `  target: ${target ?? "current session"}`,
    `  known LSP diagnostics: ${snapshot ? countDiagnosticSnapshotDiagnostics(snapshot) : 0}`,
  ];

  if (refresh) lines.push(`  refresh: ${formatExplicitDiagnosticRefresh(refresh)}`);

  if (workspaceScan) {
    const summary = workspaceScan.summary;
    const completeness = summary.complete
      ? "complete"
      : summary.traversalComplete
        ? "completed with non-fresh files"
        : "bounded/incomplete";
    const bounds = [
      `${summary.entriesVisited}/${summary.entryLimit} entries visited`,
      `file limit ${summary.fileLimit}`,
      `${formatBytes(summary.sourceBytes)}/${formatBytes(summary.sourceByteLimit)} source`,
      summary.fileLimitReached ? "file limit reached" : undefined,
      summary.entryLimitReached ? "entry limit reached" : undefined,
      summary.sourceByteLimitReached ? "source byte limit reached" : undefined,
      summary.deadlineReached ? "scan deadline reached" : undefined,
    ].filter(Boolean).join(" · ");
    const excluded = [
      summary.ignoredDirectories > 0 ? `${summary.ignoredDirectories} ignored director${summary.ignoredDirectories === 1 ? "y" : "ies"}` : undefined,
      summary.symlinksSkipped > 0 ? `${summary.symlinksSkipped} symlink${summary.symlinksSkipped === 1 ? "" : "s"}` : undefined,
      summary.boundaryEntriesSkipped > 0 ? `${summary.boundaryEntriesSkipped} boundary mismatch${summary.boundaryEntriesSkipped === 1 ? "" : "es"}` : undefined,
      summary.walkErrors > 0 ? `${summary.walkErrors} unreadable director${summary.walkErrors === 1 ? "y" : "ies"}` : undefined,
    ].filter(Boolean).join(" · ");
    const diagnosticState = summary.eventualStateFiles > 0
      ? `${summary.eventualStateFiles} ${summary.eventualStateFiles === 1 ? "file includes" : "files include"} current push state`
      : "fresh diagnostics only";
    lines.push(
      `  scan: ${completeness} (${summary.durationMs}ms)`,
      `  files: ${summary.selectedFiles} selected · ${summary.freshFiles} fresh · ${summary.eventualFiles} current push state · ${summary.timedOutFiles} timed out · ${summary.unavailableFiles} unavailable · ${summary.skippedFiles} skipped`,
      `  diagnostic state: ${diagnosticState}`,
      `  protocol: ${summary.workspacePullRequests} workspace pull${summary.workspacePullRequests === 1 ? "" : "s"} · ${summary.workspacePullFiles} workspace-covered · ${summary.documentPullFiles} document-pulled · ${summary.pushBatchFiles} push-batched · ${summary.workspacePullFailures} pull failure${summary.workspacePullFailures === 1 ? "" : "s"}`,
      `  bounds: ${bounds}`,
    );
    if (excluded) lines.push(`  excluded: ${excluded}`);

    const nonFreshFiles = workspaceScan.files.filter((file) => file.outcome !== "fresh");
    if (nonFreshFiles.length > 0) {
      lines.push("", "  non-fresh files:");
      for (const file of nonFreshFiles.slice(0, 20)) {
        const displayPath = displayPathFromRoot(file.filePath, runtime.projectRoot);
        const reason = file.reason ? ` — ${projectRelativeText(file.reason, runtime.projectRoot)}` : "";
        lines.push(`    ${file.outcome.toUpperCase()} ${displayPath}${reason}`);
      }
      if (nonFreshFiles.length > 20) lines.push(`    ... ${nonFreshFiles.length - 20} more`);
    }
  }

  if (snapshot && countDiagnosticSnapshotDiagnostics(snapshot) > 0) {
    lines.push("", "  diagnostics:");
    for (const diagnostic of flattenDiagnosticSnapshot(snapshot).slice(0, 30)) {
      lines.push(...formatDiagnostic(runtime.projectRoot, diagnostic, 4));
    }
    const hidden = countDiagnosticSnapshotDiagnostics(snapshot) - 30;
    if (hidden > 0) lines.push(`    ... ${hidden} more`);
  }

  const recent = runtime.completedEdits
    .filter((edit) => !targetPath || diagnosticTargetContainsFile(targetPath, edit.filePath, workspaceScan !== undefined))
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
    const diffSource = edit.skippedReason ?? formatRangeComputation(edit.rangeComputation);
    const operation = edit.applyPatchOperationIndex === undefined ? "" : ` op#${edit.applyPatchOperationIndex + 1}`;
    lines.push(`    ${relative}: ${ranges} [${edit.toolName}${operation}, ${diffSource}]`);
    if (edit.formatter?.changed || edit.formatter?.errors.length) {
      lines.push(`      ${formatFormatterSummary(edit.formatter)}`);
    }
    if (edit.diagnosticFilter) {
      const summary = edit.diagnosticFilter.summary;
      lines.push(`      diagnostics: ${summary.shownDiagnostics}/${summary.linkedDiagnostics} linked shown, ${summary.hiddenUnrelated} unrelated hidden`);
    }
    if (edit.workspaceDelta) {
      const summary = edit.workspaceDelta.summary;
      lines.push(`      possible workspace impact: ${summary.shownDiagnostics}/${summary.totalNewOrWorsened} new or worsened cross-file diagnostics shown (not attributed)`);
    }
  }

  return lines.join("\n");
}

function formatExplicitDiagnosticRefresh(refresh: ExplicitDiagnosticRefreshStatus): string {
  const duration = refresh.durationMs === undefined ? "" : ` (${Math.max(0, Math.round(refresh.durationMs))}ms)`;
  switch (refresh.outcome) {
    case "fresh":
      return `fresh${duration}`;
    case "eventual":
      return `current push state${duration} — server may update asynchronously`;
    case "timed-out":
      return `timed out${duration} — no diagnostics returned`;
    case "unavailable":
      return "unavailable — no diagnostics returned";
  }
}

function diagnosticTargetContainsFile(targetPath: string, filePath: string, includeDescendants: boolean): boolean {
  const target = path.resolve(targetPath);
  const file = path.resolve(filePath);
  if (file === target) return true;
  if (!includeDescendants) return false;
  const relative = path.relative(target, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatRangeComputation(computation: TouchedRangeComputation | undefined): string {
  if (!computation) return "unknown";
  const source = computation.source === "tool-diff"
    ? "tool diff"
    : computation.source === "content-diff"
      ? "content diff"
      : "whole file";
  const toolDiff = computation.toolDiff;
  if (toolDiff.present && !toolDiff.used) {
    const reason = toolDiff.skippedReason === "too-large" ? "tool diff too large" : "tool diff unparseable";
    return `${source} (${reason})`;
  }
  return source;
}

export function renderInlineDiagnosticFeedback(runtime: CodeFeedbackRuntime, edit: CompletedEdit): string | undefined {
  const filter = edit.diagnosticFilter;
  const hasLinkedDiagnostics = Boolean(filter && filter.linked.length > 0);
  const hasWorkspaceDelta = Boolean(edit.workspaceDelta?.diagnostics.length);
  const hasFormatterFeedback = Boolean(edit.formatter?.changed || edit.formatter?.errors.length);
  const hasSkippedFeedback = Boolean(edit.skippedReason?.startsWith("skipped "));
  if (!hasLinkedDiagnostics && !hasWorkspaceDelta && !hasFormatterFeedback && !hasSkippedFeedback) return undefined;

  const lines = ["code-feedback:"];

  if (hasSkippedFeedback && edit.skippedReason) {
    lines.push(`  ${edit.skippedReason}; exact edit feedback skipped`);
  }

  if (edit.formatter?.changed || edit.formatter?.errors.length) {
    lines.push(`  ${formatFormatterSummary(edit.formatter, runtime.projectRoot, edit.filePath)}`);
  }

  if (filter && filter.linked.length > 0) {
    const severityCounts = countDiagnosticSeverities(filter.linked.map((linked) => linked.diagnostic));
    const label = runtime.config.diagnostics.inline === "all" ? "diagnostics" : "touched diagnostics";
    lines.push(`  ${label}: ${formatSeverityCounts(severityCounts)}`);

    for (const linked of filter.linked) {
      lines.push("", ...formatLinkedDiagnostic(runtime.projectRoot, linked));
    }

    const hiddenText = formatHiddenDiagnostics(filter, edit.workspaceDelta?.summary.totalNewOrWorsened ?? 0);
    if (hiddenText) lines.push("", `  hidden: ${hiddenText}`);
  }

  if (hasWorkspaceDelta && edit.workspaceDelta) {
    lines.push("", ...formatWorkspaceDelta(runtime.projectRoot, edit.workspaceDelta));
  }

  return lines.join("\n");
}

export function renderDelayedDiagnosticFeedback(runtime: CodeFeedbackRuntime, edit: CompletedEdit): string | undefined {
  const filter = edit.diagnosticFilter;
  const hasLinkedDiagnostics = Boolean(filter?.linked.length);
  const hasWorkspaceDelta = Boolean(edit.workspaceDelta?.diagnostics.length);
  if (!hasLinkedDiagnostics && !hasWorkspaceDelta) return undefined;

  const relative = displayPathFromRoot(edit.filePath, runtime.projectRoot);
  const scope = runtime.config.diagnostics.inline === "all" ? "all files" : relative;
  const lines = ["code-feedback delayed LSP diagnostics:"];

  if (hasLinkedDiagnostics && filter) {
    const severityCounts = countDiagnosticSeverities(filter.linked.map((linked) => linked.diagnostic));
    lines.push(`  ${scope}: ${formatSeverityCounts(severityCounts)}`);
    for (const linked of filter.linked) {
      lines.push("", ...formatLinkedDiagnostic(runtime.projectRoot, linked));
    }

    const hiddenText = formatHiddenDiagnostics(filter, edit.workspaceDelta?.summary.totalNewOrWorsened ?? 0);
    if (hiddenText) lines.push("", `  hidden: ${hiddenText}`);
  }

  if (hasWorkspaceDelta && edit.workspaceDelta) {
    lines.push("", ...formatWorkspaceDelta(runtime.projectRoot, edit.workspaceDelta));
  }
  return lines.join("\n");
}

export function renderDelayedContextMessage(feedback: DelayedDiagnosticFeedback[]): string {
  const blocks = feedback.map((entry) => entry.text.trim()).filter(Boolean);
  const prefix = [
    "Delayed code-feedback LSP feedback arrived after the previous tool-result timeout.",
    "Treat it as follow-up diagnostics for edits you already made:",
  ].join("\n");
  return [prefix, ...blocks].join("\n\n");
}

export function renderFooterStatus(runtime: CodeFeedbackRuntime, theme?: FooterTheme, lspStatus?: LspServiceStatus): string {
  const text = footerStatusText(runtime, lspStatus);
  return theme ? theme.fg("dim", text) : text;
}

function footerStatusText(runtime: CodeFeedbackRuntime, lspStatus?: LspServiceStatus): string {
  const trusted = formatFooterTrustedRoots(runtime);
  if (!runtime.projectTrusted) return `lsp: untrusted${trusted}`;
  if (!runtime.config.enabled || !runtime.config.lsp.enabled) return `lsp: off${trusted}`;

  const clients = (lspStatus?.clients ?? [])
    .filter((client) => client.state === "ready" || client.state === "starting" || client.state === "queued")
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
  const ordered = ["ready", "starting", "queued", "failed", "stopped"]
    .map((state) => [state, counts.get(state) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  return `${lspStatus.clients.length} total${ordered ? ` (${ordered})` : ""}`;
}

function formatDiagnosticRefreshSummary(lspStatus?: LspServiceStatus): string {
  const refreshes = lspStatus?.diagnosticRefreshes;
  if (!refreshes) return "";
  const busy = [
    refreshes.active > 0 ? `active=${refreshes.active}` : undefined,
    refreshes.queued > 0 ? `queued=${refreshes.queued}` : undefined,
  ].filter(Boolean).join(" ");
  return busy ? ` (${busy})` : "";
}

function formatClientResourceSummary(
  lspStatus: LspServiceStatus | undefined,
  configuredMax: number,
  configuredInitializationConcurrency: number,
): string {
  const resources = lspStatus?.clientResources;
  if (!resources) return `max=${configuredMax}, initializing max=${configuredInitializationConcurrency}`;
  return [
    `idle=${resources.idleTimeoutMs}ms`,
    `active=${resources.activeClients}/${resources.maxActiveClients}`,
    `initializing=${resources.initializingClients}/${resources.initializationConcurrency}`,
    `queued=${resources.queuedStarts}`,
    `starts=${resources.starts}`,
    `restarts=${resources.restarts}`,
    `evictions=${resources.evictions}(idle=${resources.idleEvictions},capacity=${resources.capacityEvictions})`,
    `cooldowns=${resources.initializationCooldowns}`,
  ].join(" ");
}

function formatFooterClient(client: LspServiceStatus["clients"][number]): string {
  const label = footerClientLabel(client);
  const latency = formatClientDiagnosticLatency(client);
  const state = client.state === "starting" ? " starting" : client.state === "queued" ? " queued" : "";
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
  switch (client.lastDiagnosticOutcome) {
    case "unavailable":
      return `unavailable ${duration}`;
    case "eventual":
      return `push ${duration}`;
    case "timeout":
      return `timeout ${duration}`;
    case "cancelled":
      return `cancelled ${duration}`;
    default:
      return duration;
  }
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDiagnostic(projectRoot: string, diagnostic: LspDiagnostic, indentColumns: number): string[] {
  const filePath = uriToFilePath(diagnostic.uri);
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
  const filePath = uriToFilePath(diagnostic.uri);
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

function formatWorkspaceDelta(projectRoot: string, delta: WorkspaceDiagnosticDelta): string[] {
  const counts = countDiagnosticSeverities(delta.diagnostics);
  const lines = [
    `  possible workspace impact (not attributed): ${formatSeverityCounts(counts)}`,
  ];
  for (const diagnostic of delta.diagnostics) {
    lines.push("", ...formatDiagnostic(projectRoot, diagnostic, 2));
  }
  if (delta.summary.hiddenByLimit > 0) {
    lines.push("", `  possible impact hidden: ${delta.summary.hiddenByLimit} beyond inline limit`);
  }
  return lines;
}

function formatHiddenDiagnostics(filter: DiagnosticFilterResult, separatelyShownUnrelated = 0): string | undefined {
  const parts: string[] = [];
  const hiddenUnrelated = Math.max(0, filter.summary.hiddenUnrelated - separatelyShownUnrelated);
  if (hiddenUnrelated > 0) {
    parts.push(`${hiddenUnrelated} unrelated`);
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

function countDiagnosticSeverities(diagnostics: LspDiagnostic[]): Record<DiagnosticSeverity, number> {
  return diagnostics.reduce<Record<DiagnosticSeverity, number>>(
    (counts, diagnostic) => {
      counts[diagnostic.severity] += 1;
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
