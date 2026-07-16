export const AGENT_PROGRESS_LIMITS = Object.freeze({
  messageScalars: 1_000,
  logScalars: 16_000,
  previewScalars: 1_000,
  metrics: 32,
  metricNameScalars: 64,
  metricUnitScalars: 64,
  metricAbsoluteValue: 1_000_000_000_000_000,
  recentWindow: 12,
  maximumRecentPage: 64,
  recentWorkspacePaths: 64,
  workspacePathScalars: 4_096,
} as const);
