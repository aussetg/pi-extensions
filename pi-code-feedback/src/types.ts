export const LSP_ACTIONS = [
  "status",
  "diagnostics",
  "hover",
  "definition",
  "references",
  "implementation",
  "type_definition",
  "symbols",
  "workspace_symbols",
  "code_actions",
  "rename",
  "capabilities",
  "reload",
  "request",
] as const;

export type LspAction = (typeof LSP_ACTIONS)[number];

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type RangeConfidence = "exact" | "expanded" | "approximate";

export type TouchedRangeSource =
  | "tool-diff"
  | "content-diff"
  | "whole-file"
  | "formatter-map";

export type DiagnosticLinkReason =
  | "overlap"
  | "expanded-symbol"
  | "related-information"
  | "new-on-touched-file"
  | "cascade-related"
  | "all-diagnostics";

export type TrackedToolName = "write" | "edit" | "apply_patch";

export interface Position {
  line: number;      // 1-based externally
  character: number; // 1-based externally
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TouchedRange {
  uri: string;
  filePath: string;
  startLine: number;
  endLine: number;
  source: TouchedRangeSource;
  confidence: RangeConfidence;
}

export interface RelatedLocation {
  uri: string;
  range: Range;
  message?: string;
}

export interface LspDiagnostic {
  uri: string;
  range: Range;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string | number;
  relatedInformation?: RelatedLocation[];
  version?: number;
}

export interface DiagnosticSnapshot {
  takenAt: number;
  byUri: Map<string, LspDiagnostic[]>;
}

export interface DiagnosticRefreshResult {
  snapshot: DiagnosticSnapshot;
  fresh: boolean;
  timedOut: boolean;
  requestedAt: number;
  completedAt: number;
}

export type LspClientState = "starting" | "ready" | "stopped" | "failed";

export interface LspClientStatus {
  id: string;
  root: string;
  command: string;
  args: string[];
  state: LspClientState;
  pid?: number;
  openDocuments: number;
  diagnosticFiles: number;
  lastDiagnosticsAt?: number;
  lastError?: string;
}

export interface LspUnavailableServer {
  id: string;
  command: string;
  filePath: string;
  reason: string;
}

export interface LspServiceStatus {
  activeClients: number;
  clients: LspClientStatus[];
  unavailableServers: LspUnavailableServer[];
}

export interface LinkedDiagnostic {
  diagnostic: LspDiagnostic;
  linkReason: DiagnosticLinkReason;
  touchedRange?: TouchedRange;
  isNewOrWorsened: boolean;
}

export interface DiagnosticFilterSummary {
  totalDiagnostics: number;
  linkedDiagnostics: number;
  shownDiagnostics: number;
  hiddenUnrelated: number;
  hiddenByLimit: number;
}

export interface DiagnosticFilterResult {
  linked: LinkedDiagnostic[];
  allLinked: LinkedDiagnostic[];
  summary: DiagnosticFilterSummary;
}

export interface PendingEdit {
  id: string;
  toolName: TrackedToolName;
  filePath: string;
  beforeContent: string | undefined;
  beforeDiagnostics: DiagnosticSnapshot | undefined;
  turnIndex: number;
  writeIndex: number;
  startedAt: number;
  applyPatchOperationIndex?: number;
  originalPath?: string;
}

export interface CompletedEdit {
  id: string;
  toolName: TrackedToolName;
  filePath: string;
  beforeContent: string | undefined;
  afterAgentContent?: string | undefined;
  afterContent: string | undefined;
  touchedRanges: TouchedRange[];
  turnIndex: number;
  writeIndex: number;
  startedAt: number;
  completedAt: number;
  skippedReason?: string;
  detailsDiffPresent: boolean;
  formatter?: FormatterSummary;
  diagnosticFilter?: DiagnosticFilterResult;
  applyPatchOperationIndex?: number;
  originalPath?: string;
}

export interface DelayedDiagnosticFeedback {
  id: string;
  editId: string;
  filePath: string;
  turnIndex: number;
  writeIndex: number;
  queuedAt: number;
  text: string;
}

export interface FormatterResult {
  formatterName?: string;
  command?: string;
  changed: boolean;
  finalContent: string;
  errors: string[];
  skippedReason?: string;
  durationMs?: number;
}

export interface FormatterSummary {
  formatterName?: string;
  command?: string;
  changed: boolean;
  errors: string[];
  skippedReason?: string;
  durationMs?: number;
}

export interface FormatterRunRecord extends FormatterSummary {
  filePath: string;
  at: number;
}

export interface FormatterCommandStatus {
  id: string;
  label: string;
  command: string;
  available: boolean;
  reason?: string;
}

export interface FormatServiceStatus {
  recentRuns: FormatterRunRecord[];
  commands: FormatterCommandStatus[];
}

export interface FeedbackConfig {
  enabled: boolean;
  strict: boolean;
  autoFormat: boolean;
  formatMode: "immediate" | "deferred";
  diagnostics: {
    inline: "touched" | "all" | "off";
    maxInline: number;
    settleMs: number;
    timeoutMs: number;
    delayedTimeoutMs: number;
    expandToSymbol: boolean;
    includeCrossFileRelated: boolean;
  };
  lsp: {
    enabled: boolean;
    idleTimeoutMs: number;
    servers: Record<string, unknown>;
  };
  formatters: Record<string, unknown>;
}

