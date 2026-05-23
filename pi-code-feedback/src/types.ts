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
  "semantic_tokens",
  "code_actions",
  "rename",
  "capabilities",
  "reload",
  "request",
] as const;

export type LspAction = (typeof LSP_ACTIONS)[number];

export const LSP_METHODS = [
  "server/status",
  "server/capabilities",
  "server/reload",
  "textDocument/diagnostic",
  "workspace/diagnostic",
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/references",
  "textDocument/implementation",
  "textDocument/typeDefinition",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "textDocument/semanticTokens",
  "textDocument/codeAction",
  "codeAction/apply",
  "textDocument/rename",
  "raw/request",
] as const;

export type LspMethod = (typeof LSP_METHODS)[number];

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type RangeConfidence = "exact" | "expanded" | "approximate";

export type TouchedRangeSource =
  | "tool-diff"
  | "content-diff"
  | "whole-file"
  | "formatter-map";

export type DiagnosticLinkReason =
  | "overlap"
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

export type LspServerLogLevel = "info" | "warning" | "error";

export interface LspServerLog {
  level: LspServerLogLevel;
  message: string;
  at: number;
}

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
  lastDiagnosticDurationMs?: number;
  lastDiagnosticTimedOut?: boolean;
  lastError?: string;
  lastServerLog?: LspServerLog;
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

export type SemanticTokenOverlayState = "ready" | "refreshing" | "unsupported" | "error";

export interface SemanticTokenLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface SemanticToken {
  line: number;      // 0-based, matching LSP semantic-token coordinates
  character: number; // 0-based UTF-16 character offset
  length: number;
  type: string;
  modifiers: string[];
}

export interface SemanticTokenOverlay {
  serverId: string;
  uri: string;
  version: number;
  state: SemanticTokenOverlayState;
  stale: boolean;
  tokens: SemanticToken[];
  legend?: SemanticTokenLegend;
  resultId?: string;
  requestedAt?: number;
  receivedAt?: number;
  error?: string;
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

export const CODE_FEEDBACK_DETAILS_KEY = "piCodeFeedback";

export const LSP_RESULT_SERVER_ID_KEY = "__piCodeFeedbackServerId";

export interface CodeFeedbackToolDetails {
  version: 1;
  inlineText: string;
  edits: CodeFeedbackEditDetails[];
}

export interface CodeFeedbackEditDetails {
  id: string;
  toolName: TrackedToolName;
  filePath: string;
  displayPath: string;
  touchedRanges: TouchedRange[];
  timing?: CodeFeedbackTiming;
  formatter?: FormatterSummary;
  diagnostics?: CodeFeedbackDiagnosticDetails;
}

export interface CodeFeedbackTimingPhase {
  name: string;
  durationMs: number;
}

export interface CodeFeedbackTiming {
  totalMs: number;
  phases: CodeFeedbackTimingPhase[];
}

export interface CodeFeedbackDiagnosticDetails {
  label: "diagnostics" | "touched diagnostics";
  linked: LinkedDiagnostic[];
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
  timing?: CodeFeedbackTiming;
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
  timing?: CodeFeedbackTiming;
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
    inlineTimeoutMs: number;
    settleMs: number;
    timeoutMs: number;
    delayedTimeoutMs: number;
    includeCrossFileRelated: boolean;
  };
  lsp: {
    enabled: boolean;
    idleTimeoutMs: number;
    servers: Record<string, unknown>;
  };
  formatters: Record<string, unknown>;
}

