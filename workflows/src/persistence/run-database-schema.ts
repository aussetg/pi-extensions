export const RUN_DATABASE_SCHEMA_VERSION = 1;
export const RUN_DATABASE_BUSY_TIMEOUT_MS = 5_000;

/**
 * The database is intentionally a complete rebuild target, not a migration
 * chain. Every table belongs to one run.sqlite file and carries run_id where
 * doing so makes boundary checks and accidental cross-run writes explicit.
 */
export const RUN_DATABASE_SCHEMA_SQL = String.raw`
CREATE TABLE runs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_source_hash TEXT NOT NULL,
  workflow_definition_hash TEXT NOT NULL,
  invocation_hash TEXT NOT NULL,
  project_snapshot_hash TEXT NOT NULL,
  route_snapshot_hash TEXT NOT NULL,
  context_identity_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'stopped')),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  safety_concurrency INTEGER NOT NULL CHECK (safety_concurrency >= 1),
  safety_maximum_agent_launches INTEGER NOT NULL CHECK (safety_maximum_agent_launches >= 1),
  safety_memory_bytes INTEGER NOT NULL CHECK (safety_memory_bytes >= 1),
  safety_tasks INTEGER NOT NULL CHECK (safety_tasks >= 1),
  safety_cpu_quota_percent INTEGER NOT NULL CHECK (safety_cpu_quota_percent >= 1),
  safety_cpu_weight INTEGER NOT NULL CHECK (safety_cpu_weight >= 1),
  safety_output_bytes INTEGER NOT NULL CHECK (safety_output_bytes >= 1),
  safety_command_timeout_ms INTEGER NOT NULL CHECK (safety_command_timeout_ms >= 1),
  usage_input_tokens INTEGER NOT NULL CHECK (usage_input_tokens >= 0),
  usage_output_tokens INTEGER NOT NULL CHECK (usage_output_tokens >= 0),
  usage_cache_read_tokens INTEGER NOT NULL CHECK (usage_cache_read_tokens >= 0),
  usage_cache_write_tokens INTEGER NOT NULL CHECK (usage_cache_write_tokens >= 0),
  usage_provider_requests INTEGER NOT NULL CHECK (usage_provider_requests >= 0),
  usage_cost REAL NOT NULL CHECK (usage_cost >= 0),
  usage_elapsed_ms INTEGER NOT NULL CHECK (usage_elapsed_ms >= 0),
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  current_operation_id TEXT REFERENCES operations(operation_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  result_artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  error_artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;

CREATE TABLE run_capabilities (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  capability TEXT NOT NULL CHECK (capability IN ('read-project', 'candidate-write', 'host-command', 'mediated-network', 'human-input')),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, capability)
) STRICT;

CREATE TABLE artifacts (
  digest TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain; charset=utf-8', 'application/json', 'application/octet-stream')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  body_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX artifacts_run_created ON artifacts(run_id, created_at, digest);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  parent_operation_id TEXT REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  path TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stage', 'loop', 'parallel', 'fan-out', 'agent', 'command', 'checkpoint', 'measure', 'candidate', 'verify', 'accept', 'reject', 'record-experiment', 'apply')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'stopped')),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  semantic_input_hash TEXT NOT NULL,
  call_key TEXT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  result_present INTEGER NOT NULL CHECK (result_present IN (0, 1)),
  result_value_json TEXT CHECK (result_value_json IS NULL OR json_valid(result_value_json)),
  result_workspace_kind TEXT CHECK (result_workspace_kind IS NULL OR result_workspace_kind IN ('snapshot', 'candidate')),
  result_workspace_id TEXT,
  result_workspace_tree_hash TEXT,
  result_workspace_lineage_hash TEXT,
  result_workspace_write_scope_hash TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (run_id, path),
  UNIQUE (run_id, ordinal),
  CHECK ((result_workspace_kind IS NULL) = (result_workspace_id IS NULL)),
  CHECK ((result_workspace_kind IS NULL) = (result_workspace_tree_hash IS NULL)),
  CHECK (result_present = 1 OR (result_value_json IS NULL AND result_workspace_kind IS NULL))
) STRICT;
CREATE INDEX operations_run_status_ordinal ON operations(run_id, status, ordinal);
CREATE INDEX operations_parent_ordinal ON operations(parent_operation_id, ordinal);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK (number >= 1),
  effect TEXT NOT NULL CHECK (effect IN ('agent', 'command', 'measurement', 'verification', 'apply')),
  execution_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'stopped')),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  pre_workspace_kind TEXT CHECK (pre_workspace_kind IS NULL OR pre_workspace_kind IN ('snapshot', 'candidate')),
  pre_workspace_id TEXT,
  pre_workspace_tree_hash TEXT,
  pre_workspace_lineage_hash TEXT,
  pre_workspace_write_scope_hash TEXT,
  post_workspace_checkpoint_id TEXT REFERENCES workspace_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED,
  usage_input_tokens INTEGER NOT NULL CHECK (usage_input_tokens >= 0),
  usage_output_tokens INTEGER NOT NULL CHECK (usage_output_tokens >= 0),
  usage_cache_read_tokens INTEGER NOT NULL CHECK (usage_cache_read_tokens >= 0),
  usage_cache_write_tokens INTEGER NOT NULL CHECK (usage_cache_write_tokens >= 0),
  usage_provider_requests INTEGER NOT NULL CHECK (usage_provider_requests >= 0),
  usage_cost REAL NOT NULL CHECK (usage_cost >= 0),
  usage_elapsed_ms INTEGER NOT NULL CHECK (usage_elapsed_ms >= 0),
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  resource_cpu_usec INTEGER,
  resource_io_read_bytes INTEGER,
  resource_io_write_bytes INTEGER,
  resource_memory_current_bytes INTEGER,
  resource_memory_peak_bytes INTEGER,
  resource_tasks_current INTEGER,
  resource_tasks_peak INTEGER,
  resource_cpu_pressure REAL,
  resource_io_pressure REAL,
  resource_memory_pressure REAL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (operation_id, number),
  CHECK ((pre_workspace_kind IS NULL) = (pre_workspace_id IS NULL)),
  CHECK ((pre_workspace_kind IS NULL) = (pre_workspace_tree_hash IS NULL))
) STRICT;
CREATE INDEX attempts_operation_number ON attempts(operation_id, number);
CREATE INDEX attempts_run_status ON attempts(run_id, status, updated_at);

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  type TEXT NOT NULL,
  operation_id TEXT REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  attempt_id TEXT REFERENCES attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;
CREATE INDEX events_run_revision ON events(run_id, revision, sequence);
CREATE INDEX events_operation_sequence ON events(operation_id, sequence);

CREATE TABLE operation_artifacts (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL CHECK (role IN ('input', 'output', 'evidence', 'progress')),
  name TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (operation_id, role, ordinal)
) STRICT;
CREATE INDEX operation_artifacts_digest ON operation_artifacts(artifact_digest, operation_id);

CREATE TABLE attempt_artifacts (
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL CHECK (role IN ('input', 'output', 'evidence', 'progress')),
  name TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (attempt_id, role, ordinal)
) STRICT;
CREATE INDEX attempt_artifacts_digest ON attempt_artifacts(artifact_digest, attempt_id);

CREATE TABLE agent_sessions (
  agent_session_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  profile_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  pi_session_path TEXT NOT NULL,
  workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('snapshot', 'candidate')),
  workspace_id TEXT NOT NULL,
  workspace_tree_hash TEXT NOT NULL,
  workspace_lineage_hash TEXT,
  workspace_write_scope_hash TEXT,
  network TEXT NOT NULL CHECK (network IN ('none', 'research')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'stopped')),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  receiptless_strikes INTEGER NOT NULL CHECK (receiptless_strikes BETWEEN 0 AND 3),
  current_execution_id TEXT,
  finish_tool_call_id TEXT,
  finish_schema_hash TEXT,
  finish_value_json TEXT CHECK (finish_value_json IS NULL OR json_valid(finish_value_json)),
  finish_committed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((finish_tool_call_id IS NULL) = (finish_schema_hash IS NULL)),
  CHECK ((finish_tool_call_id IS NULL) = (finish_committed_at IS NULL)),
  CHECK (finish_tool_call_id IS NOT NULL OR finish_value_json IS NULL)
) STRICT;
CREATE INDEX agent_sessions_run_status ON agent_sessions(run_id, status, updated_at);

CREATE TABLE agent_finish_artifacts (
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (agent_session_id, ordinal)
) STRICT;

CREATE TABLE agent_tool_receipts (
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  execution_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN (
    'finish_work', 'report_progress', 'log_result', 'publish_artifact',
    'web_search', 'web_fetch', 'workspace_command'
  )),
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (agent_session_id, tool_call_id)
) STRICT;
CREATE INDEX agent_tool_receipts_session_time
  ON agent_tool_receipts(agent_session_id, committed_at, tool_call_id);

CREATE TABLE agent_progress_current (
  agent_session_id TEXT PRIMARY KEY REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  message TEXT,
  current_value INTEGER CHECK (current_value IS NULL OR current_value >= 0),
  total_value INTEGER CHECK (total_value IS NULL OR total_value >= 0),
  usage_input_tokens INTEGER NOT NULL CHECK (usage_input_tokens >= 0),
  usage_output_tokens INTEGER NOT NULL CHECK (usage_output_tokens >= 0),
  usage_cache_read_tokens INTEGER NOT NULL CHECK (usage_cache_read_tokens >= 0),
  usage_cache_write_tokens INTEGER NOT NULL CHECK (usage_cache_write_tokens >= 0),
  usage_provider_requests INTEGER NOT NULL CHECK (usage_provider_requests >= 0),
  usage_cost REAL NOT NULL CHECK (usage_cost >= 0),
  usage_elapsed_ms INTEGER NOT NULL CHECK (usage_elapsed_ms >= 0),
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  model_turn INTEGER NOT NULL CHECK (model_turn >= 0),
  current_tool TEXT,
  tool_count INTEGER NOT NULL CHECK (tool_count >= 0),
  retries INTEGER NOT NULL CHECK (retries >= 0),
  workspace_changed INTEGER NOT NULL CHECK (workspace_changed IN (0, 1)),
  workspace_change_count INTEGER NOT NULL CHECK (workspace_change_count >= 0),
  resource_cpu_usec INTEGER,
  resource_io_read_bytes INTEGER,
  resource_io_write_bytes INTEGER,
  resource_memory_current_bytes INTEGER,
  resource_memory_peak_bytes INTEGER,
  resource_tasks_current INTEGER,
  resource_tasks_peak INTEGER,
  resource_cpu_pressure REAL,
  resource_io_pressure REAL,
  resource_memory_pressure REAL,
  updated_at TEXT NOT NULL,
  CHECK (current_value IS NULL OR total_value IS NULL OR current_value <= total_value)
) STRICT;

CREATE TABLE agent_progress_current_paths (
  agent_session_id TEXT NOT NULL REFERENCES agent_progress_current(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  path TEXT NOT NULL,
  PRIMARY KEY (agent_session_id, ordinal),
  UNIQUE (agent_session_id, path)
) STRICT;

CREATE TABLE agent_progress_current_metrics (
  agent_session_id TEXT NOT NULL REFERENCES agent_progress_current(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  PRIMARY KEY (agent_session_id, ordinal),
  UNIQUE (agent_session_id, name)
) STRICT;

CREATE TABLE agent_progress_history (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  at TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('report', 'log', 'artifact', 'observed')),
  message TEXT,
  artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  name TEXT,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (run_id, sequence)
) STRICT;
CREATE INDEX agent_progress_session_sequence ON agent_progress_history(agent_session_id, sequence);
CREATE INDEX agent_progress_visible_recent ON agent_progress_history(agent_session_id, visible, sequence DESC);

CREATE TABLE candidate_workspaces (
  workspace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  logical_id TEXT NOT NULL,
  parent_candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  initial_tree_hash TEXT NOT NULL,
  lineage_hash TEXT NOT NULL,
  write_scope_json TEXT NOT NULL CHECK (json_valid(write_scope_json)),
  write_scope_hash TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, logical_id),
  UNIQUE (run_id, root_path)
) STRICT;
CREATE INDEX candidate_workspaces_run_created ON candidate_workspaces(run_id, created_at, workspace_id);

CREATE TABLE workspace_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  workspace_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  lineage_hash TEXT,
  write_scope_hash TEXT,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX workspace_checkpoints_operation_created ON workspace_checkpoints(operation_id, created_at);

CREATE TABLE workflow_calls (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  previous_journal_key TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  call_key TEXT NOT NULL,
  completion_authority TEXT NOT NULL CHECK (completion_authority IN ('finish-work', 'host-effect')),
  replay_policy TEXT NOT NULL CHECK (replay_policy IN ('immutable', 'workspace', 'never')),
  result_value_json TEXT CHECK (result_value_json IS NULL OR json_valid(result_value_json)),
  result_workspace_kind TEXT CHECK (result_workspace_kind IS NULL OR result_workspace_kind IN ('snapshot', 'candidate')),
  result_workspace_id TEXT,
  result_workspace_tree_hash TEXT,
  result_workspace_lineage_hash TEXT,
  result_workspace_write_scope_hash TEXT,
  post_workspace_checkpoint_id TEXT REFERENCES workspace_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED,
  committed_at TEXT NOT NULL,
  UNIQUE (run_id, ordinal),
  CHECK ((result_workspace_kind IS NULL) = (result_workspace_id IS NULL)),
  CHECK ((result_workspace_kind IS NULL) = (result_workspace_tree_hash IS NULL))
) STRICT;

CREATE TABLE workflow_call_artifacts (
  operation_id TEXT NOT NULL REFERENCES workflow_calls(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (operation_id, ordinal)
) STRICT;

CREATE TABLE operation_replays (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  source_run_id TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  call_key TEXT NOT NULL,
  restored_workspace_checkpoint_id TEXT REFERENCES workspace_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE run_replay (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  mode TEXT NOT NULL CHECK (mode IN ('same-run', 'cross-revision-prefix')),
  source_run_id TEXT NOT NULL,
  matched_calls INTEGER NOT NULL CHECK (matched_calls >= 0),
  first_miss_ordinal INTEGER CHECK (first_miss_ordinal IS NULL OR first_miss_ordinal >= 0),
  first_miss_reason TEXT,
  fresh INTEGER NOT NULL CHECK (fresh IN (0, 1))
) STRICT;

CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  parent_candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  workspace_id TEXT NOT NULL REFERENCES candidate_workspaces(workspace_id) DEFERRABLE INITIALLY DEFERRED,
  tree_hash TEXT NOT NULL,
  lineage_hash TEXT,
  write_scope_hash TEXT,
  manifest_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  diff_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  frozen_at TEXT NOT NULL
) STRICT;
CREATE INDEX candidates_run_frozen ON candidates(run_id, frozen_at, candidate_id);

CREATE TABLE candidate_changed_paths (
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  path TEXT NOT NULL,
  PRIMARY KEY (candidate_id, ordinal),
  UNIQUE (candidate_id, path)
) STRICT;

CREATE TABLE measurements (
  measurement_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  attempt_id TEXT UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  profile_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  command_hash TEXT NOT NULL,
  workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('snapshot', 'candidate')),
  workspace_id TEXT NOT NULL,
  workspace_tree_hash TEXT NOT NULL,
  workspace_lineage_hash TEXT,
  workspace_write_scope_hash TEXT,
  candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  sampling_json TEXT NOT NULL CHECK (json_valid(sampling_json)),
  sampling_hash TEXT NOT NULL,
  cpu_affinity_physical_cores INTEGER CHECK (cpu_affinity_physical_cores IS NULL OR cpu_affinity_physical_cores >= 1),
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
  environment_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  cohort_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  diagnostics_artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  CHECK ((workspace_kind = 'candidate') = (candidate_id IS NOT NULL)),
  CHECK ((workspace_kind = 'candidate') = (workspace_lineage_hash IS NOT NULL)),
  CHECK ((workspace_kind = 'candidate') = (workspace_write_scope_hash IS NOT NULL))
) STRICT;
CREATE INDEX measurements_run_ended ON measurements(run_id, ended_at, measurement_id);
CREATE INDEX measurements_binding ON measurements(run_id, binding_hash, ended_at);

CREATE TABLE measurement_samples (
  measurement_id TEXT NOT NULL REFERENCES measurements(measurement_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('warmup', 'sample')),
  sample_index INTEGER NOT NULL CHECK (sample_index >= 0),
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'timed-out', 'output-limited', 'infrastructure-failure', 'cancelled')),
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  stdout_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  stderr_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  cgroup_json TEXT CHECK (cgroup_json IS NULL OR json_valid(cgroup_json)),
  host_psi_json TEXT NOT NULL CHECK (json_valid(host_psi_json)),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (measurement_id, ordinal),
  UNIQUE (measurement_id, kind, sample_index)
) STRICT;

CREATE TABLE metrics (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  metric_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  definition_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'guardrail', 'secondary')),
  baseline REAL,
  current_value REAL,
  best REAL,
  relative_gain REAL,
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0),
  baseline_profile_id TEXT,
  baseline_profile_hash TEXT,
  baseline_environment_hash TEXT,
  PRIMARY KEY (run_id, metric_id),
  CHECK ((baseline IS NULL) = (observation_count = 0)),
  CHECK ((baseline IS NULL) = (baseline_profile_hash IS NULL)),
  CHECK ((baseline IS NULL) = (baseline_environment_hash IS NULL))
) STRICT;

CREATE TABLE measurement_observations (
  measurement_id TEXT NOT NULL REFERENCES measurements(measurement_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  observation_id TEXT NOT NULL UNIQUE,
  metric_id TEXT NOT NULL,
  output_id TEXT NOT NULL,
  value REAL NOT NULL,
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  initial_status TEXT NOT NULL CHECK (initial_status IN ('baseline', 'observational', 'pending')),
  status TEXT NOT NULL CHECK (status IN ('baseline', 'observational', 'pending', 'accepted', 'rejected')),
  improvement_passed INTEGER CHECK (improvement_passed IS NULL OR improvement_passed IN (0, 1)),
  guardrail_passed INTEGER CHECK (guardrail_passed IS NULL OR guardrail_passed IN (0, 1)),
  PRIMARY KEY (measurement_id, ordinal),
  FOREIGN KEY (run_id, metric_id) REFERENCES metrics(run_id, metric_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX measurement_observations_metric_sequence ON measurement_observations(run_id, metric_id, sequence DESC);

CREATE TABLE experiments (
  experiment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  measurement_id TEXT NOT NULL REFERENCES measurements(measurement_id) DEFERRABLE INITIALLY DEFERRED,
  disposition_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  learned TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  binding_hash TEXT NOT NULL,
  record_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, candidate_id)
) STRICT;
CREATE INDEX experiments_run_created ON experiments(run_id, created_at, experiment_id);

CREATE TABLE verifications (
  verification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  candidate_tree_hash TEXT NOT NULL,
  candidate_lineage_hash TEXT NOT NULL,
  candidate_write_scope_hash TEXT NOT NULL,
  project_snapshot_hash TEXT NOT NULL,
  live_project_tree_hash TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  gate_environment_hash TEXT NOT NULL,
  evidence_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (operation_id, attempt_number)
) STRICT;
CREATE INDEX verifications_candidate_created ON verifications(candidate_id, created_at, verification_id);

CREATE TABLE verification_gates (
  verification_id TEXT NOT NULL REFERENCES verifications(verification_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('tests', 'diagnostics', 'diff-inspection', 'adversarial-review', 'contamination')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'blocked', 'not-applicable')),
  summary TEXT NOT NULL,
  environment_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  agent_session_id TEXT REFERENCES agent_sessions(agent_session_id) DEFERRABLE INITIALLY DEFERRED,
  finish_tool_call_id TEXT,
  finish_schema_hash TEXT,
  PRIMARY KEY (verification_id, ordinal),
  UNIQUE (verification_id, kind),
  CHECK ((agent_session_id IS NULL) = (finish_tool_call_id IS NULL)),
  CHECK ((agent_session_id IS NULL) = (finish_schema_hash IS NULL))
) STRICT;

CREATE TABLE apply_plans (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  candidate_tree_hash TEXT NOT NULL,
  candidate_lineage_hash TEXT NOT NULL,
  candidate_write_scope_hash TEXT NOT NULL,
  verification_id TEXT NOT NULL REFERENCES verifications(verification_id) DEFERRABLE INITIALLY DEFERRED,
  verification_profile_hash TEXT NOT NULL,
  gate_environment_hash TEXT NOT NULL,
  project_snapshot_hash TEXT NOT NULL,
  live_project_tree_hash TEXT NOT NULL,
  unrelated_live_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  manifest_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id) DEFERRABLE INITIALLY DEFERRED,
  challenge_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE apply_plan_paths (
  plan_id TEXT NOT NULL REFERENCES apply_plans(plan_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  path TEXT NOT NULL,
  preimage_json TEXT NOT NULL CHECK (json_valid(preimage_json)),
  postimage_json TEXT NOT NULL CHECK (json_valid(postimage_json)),
  content_artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (plan_id, ordinal),
  UNIQUE (plan_id, path)
) STRICT;

CREATE TABLE apply_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  plan_id TEXT NOT NULL UNIQUE REFERENCES apply_plans(plan_id) DEFERRABLE INITIALLY DEFERRED,
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id) DEFERRABLE INITIALLY DEFERRED,
  challenge_hash TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  verification_id TEXT NOT NULL REFERENCES verifications(verification_id) DEFERRABLE INITIALLY DEFERRED,
  mutation_id TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL CHECK (json_valid(changed_paths_json)),
  reconciled INTEGER NOT NULL CHECK (reconciled IN (0, 1)),
  observed_postimage_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE human_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'completed', 'stopped')),
  request_kind TEXT NOT NULL CHECK (request_kind IN ('confirm', 'choice', 'input')),
  title TEXT,
  prompt TEXT NOT NULL,
  choices_json TEXT CHECK (choices_json IS NULL OR json_valid(choices_json)),
  response_schema_json TEXT CHECK (response_schema_json IS NULL OR json_valid(response_schema_json)),
  challenge_hash TEXT NOT NULL,
  requested_revision INTEGER NOT NULL CHECK (requested_revision >= 1),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((request_kind = 'choice') = (choices_json IS NOT NULL)),
  CHECK ((request_kind = 'input') = (response_schema_json IS NOT NULL))
) STRICT;
CREATE INDEX human_checkpoints_run_status ON human_checkpoints(run_id, status, requested_at);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN ('apply', 'draft-promotion')),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'completed', 'stopped')),
  challenge_hash TEXT NOT NULL,
  challenged_run_revision INTEGER NOT NULL CHECK (challenged_run_revision >= 1),
  binding_hash TEXT NOT NULL,
  summary_artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
  actor TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE INDEX approvals_run_status ON approvals(run_id, status, requested_at);

CREATE TABLE control_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  inbox_sequence INTEGER NOT NULL UNIQUE CHECK (inbox_sequence >= 1),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('pause', 'resume', 'stop', 'stop-effect', 'checkpoint-response', 'approve', 'reject', 'shutdown')),
  requested_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation_id TEXT REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  reason TEXT,
  checkpoint_id TEXT REFERENCES human_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED,
  approval_id TEXT REFERENCES approvals(approval_id) DEFERRABLE INITIALLY DEFERRED,
  challenge_hash TEXT,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  CHECK (
    (kind = 'pause' AND operation_id IS NULL AND checkpoint_id IS NULL AND approval_id IS NULL AND challenge_hash IS NULL AND value_json IS NULL)
    OR (kind = 'resume' AND operation_id IS NULL AND reason IS NULL AND checkpoint_id IS NULL AND approval_id IS NULL AND challenge_hash IS NULL AND value_json IS NULL)
    OR (kind = 'stop' AND operation_id IS NULL AND checkpoint_id IS NULL AND approval_id IS NULL AND challenge_hash IS NULL AND value_json IS NULL)
    OR (kind = 'stop-effect' AND operation_id IS NOT NULL AND checkpoint_id IS NULL AND approval_id IS NULL AND challenge_hash IS NULL AND value_json IS NULL)
    OR (kind = 'checkpoint-response' AND operation_id IS NULL AND reason IS NULL AND checkpoint_id IS NOT NULL AND approval_id IS NULL AND challenge_hash IS NOT NULL AND value_json IS NOT NULL)
    OR (kind = 'approve' AND operation_id IS NULL AND reason IS NULL AND checkpoint_id IS NULL AND approval_id IS NOT NULL AND challenge_hash IS NOT NULL AND value_json IS NULL)
    OR (kind = 'reject' AND operation_id IS NULL AND checkpoint_id IS NULL AND approval_id IS NOT NULL AND challenge_hash IS NOT NULL AND value_json IS NULL)
    OR (kind = 'shutdown' AND operation_id IS NULL AND reason IS NULL AND checkpoint_id IS NULL AND approval_id IS NULL AND challenge_hash IS NULL AND value_json IS NULL)
  )
) STRICT;
CREATE INDEX control_requests_run_order ON control_requests(run_id, inbox_sequence);

CREATE TABLE control_acknowledgements (
  request_id TEXT PRIMARY KEY REFERENCES control_requests(request_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  acknowledged_at TEXT NOT NULL
) STRICT;
CREATE INDEX control_acknowledgements_run_revision ON control_acknowledgements(run_id, revision);

PRAGMA user_version = ${RUN_DATABASE_SCHEMA_VERSION};
`;
