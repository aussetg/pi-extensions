export const WORKFLOW_RUN_DATABASE_SCHEMA_VERSION = 4;
export const WORKFLOW_RUN_DATABASE_BUSY_TIMEOUT_MS = 5_000;

/**
 * The v17 database is a clean per-run rebuild. It deliberately has no migration path from the
 * completion-ordered schema 3: old files remain immutable legacy evidence.
 */
export const WORKFLOW_RUN_DATABASE_SCHEMA_SQL = String.raw`
CREATE TABLE runs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_source_hash TEXT NOT NULL,
  workflow_definition_hash TEXT NOT NULL,
  invocation_snapshot_hash TEXT NOT NULL,
  runtime_api_hash TEXT NOT NULL,
  invocation_hash TEXT NOT NULL,
  resources_hash TEXT NOT NULL,
  project_snapshot_hash TEXT NOT NULL,
  route_snapshot_hash TEXT NOT NULL,
  static_resources_hash TEXT NOT NULL,
  context_identity_hash TEXT NOT NULL,
  launch_authority TEXT NOT NULL CHECK (launch_authority IN ('model', 'user', 'rpc')),
  exposure TEXT NOT NULL CHECK (exposure IN ('human', 'model')),
  policy_hash TEXT NOT NULL,
  project_trusted INTEGER NOT NULL CHECK (project_trusted IN (0, 1)),
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
  root_scope_id TEXT NOT NULL REFERENCES scopes(scope_id) DEFERRABLE INITIALLY DEFERRED,
  current_operation_id TEXT REFERENCES operations(operation_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  root_terminal_key TEXT,
  result_present INTEGER NOT NULL CHECK (result_present IN (0, 1)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (launch_authority <> 'model' OR exposure = 'model'),
  CHECK (workflow_id NOT LIKE 'project:%' OR project_trusted = 1),
  CHECK ((status = 'completed') = (root_terminal_key IS NOT NULL)),
  CHECK ((status = 'completed') = (result_present = 1)),
  CHECK (result_present = 1 OR result_json IS NULL),
  CHECK ((status IN ('completed', 'failed', 'stopped')) = (ended_at IS NOT NULL))
) STRICT;

CREATE TABLE run_capabilities (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  capability TEXT NOT NULL CHECK (capability IN ('read-project', 'candidate-write', 'host-command', 'mediated-network', 'human-input')),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, capability)
) STRICT;

CREATE TABLE invocation_resources (
  resource_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind = 'measurement-profile'),
  input_path TEXT NOT NULL,
  selector TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
  UNIQUE (run_id, kind, input_path),
  UNIQUE (run_id, resource_id)
) STRICT;
CREATE INDEX invocation_resources_run_kind ON invocation_resources(run_id, kind, input_path);

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  type TEXT NOT NULL,
  operation_id TEXT REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  scope_id TEXT REFERENCES scopes(scope_id) DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, revision)
) STRICT;
CREATE INDEX events_operation_sequence ON events(operation_id, sequence);
CREATE INDEX events_scope_sequence ON events(scope_id, sequence);
CREATE INDEX events_candidate_sequence ON events(candidate_id, sequence);

CREATE TABLE human_interactions (
  interaction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'apply')),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'answered', 'approved', 'rejected')),
  challenge_hash TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((status = 'waiting') = (resolved_at IS NULL)),
  CHECK ((status = 'answered') = (response_json IS NOT NULL)),
  CHECK (kind = 'ask' OR status <> 'answered'),
  CHECK (kind = 'apply' OR status NOT IN ('approved', 'rejected'))
) STRICT;
CREATE INDEX human_interactions_run_status ON human_interactions(run_id, status, requested_at);

CREATE TABLE control_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN (
    'pause', 'resume', 'stop', 'stop-effect', 'ask-response', 'apply-approve', 'apply-reject'
  )),
  target_id TEXT,
  challenge_hash TEXT,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'rejected')),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  requested_at TEXT NOT NULL,
  processed_at TEXT,
  CHECK ((status = 'pending') = (processed_at IS NULL))
) STRICT;
CREATE INDEX control_requests_run_status ON control_requests(run_id, status, requested_at, request_id);

CREATE TABLE scopes (
  scope_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  parent_scope_id TEXT REFERENCES scopes(scope_id) DEFERRABLE INITIALLY DEFERRED,
  owner_operation_id TEXT REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'parallel-branch', 'map-item', 'candidate-body')),
  sibling_ordinal INTEGER NOT NULL CHECK (sibling_ordinal >= 0),
  lane_key TEXT,
  seed_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
  terminal_key TEXT,
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (run_id, path),
  UNIQUE (run_id, scope_id),
  UNIQUE (owner_operation_id, sibling_ordinal),
  CHECK ((kind = 'root') = (parent_scope_id IS NULL)),
  CHECK ((kind = 'root') = (owner_operation_id IS NULL)),
  CHECK ((kind IN ('parallel-branch', 'map-item')) = (lane_key IS NOT NULL)),
  CHECK ((status = 'active') = (terminal_key IS NULL)),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK ((status IN ('failed', 'cancelled')) = (failure_json IS NOT NULL))
) STRICT;
CREATE INDEX scopes_parent_sibling ON scopes(parent_scope_id, sibling_ordinal);
CREATE INDEX scopes_owner_sibling ON scopes(owner_operation_id, sibling_ordinal);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'parallel', 'map', 'agent', 'command', 'ask', 'measure', 'candidate',
    'verify', 'accept', 'reject', 'record-experiment', 'apply'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_site TEXT NOT NULL,
  descriptor_source_site TEXT,
  title TEXT,
  semantic_input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'stopped', 'cancelled')),
  result_present INTEGER NOT NULL CHECK (result_present IN (0, 1)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  call_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (scope_id, cursor),
  UNIQUE (run_id, path),
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, operation_id),
  CHECK (result_present = 1 OR result_json IS NULL),
  CHECK ((status = 'completed') = (result_present = 1)),
  CHECK ((status = 'failed') = (failure_json IS NOT NULL)),
  CHECK ((status IN ('completed', 'failed')) = (call_key IS NOT NULL)),
  CHECK ((status IN ('running', 'waiting')) = (ended_at IS NULL))
) STRICT;
CREATE INDEX operations_scope_cursor ON operations(scope_id, cursor);
CREATE INDEX operations_run_ordinal ON operations(run_id, ordinal);
CREATE INDEX operations_run_status ON operations(run_id, status, ordinal);

CREATE TABLE effect_settlements (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  semantic_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  completion_authority TEXT NOT NULL CHECK (completion_authority IN ('finish-work', 'host-effect')),
  replay_policy TEXT NOT NULL CHECK (replay_policy IN ('immutable', 'workspace', 'never')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  post_workspace_checkpoint_id TEXT REFERENCES workspace_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED,
  settled_at TEXT NOT NULL,
  CHECK ((outcome = 'success') = (result_json IS NOT NULL)),
  CHECK ((outcome = 'failure') = (failure_json IS NOT NULL)),
  CHECK (outcome = 'success' OR replay_policy = 'never'),
  CHECK ((replay_policy = 'workspace') = (post_workspace_checkpoint_id IS NOT NULL))
) STRICT;
CREATE INDEX effect_settlements_run_time ON effect_settlements(run_id, settled_at, operation_id);

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

CREATE TABLE operation_artifacts (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL CHECK (role IN ('input', 'output', 'evidence', 'progress')),
  name TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (operation_id, role, ordinal),
  UNIQUE (operation_id, role, name)
) STRICT;
CREATE INDEX operation_artifacts_digest ON operation_artifacts(artifact_digest, operation_id);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK (number >= 1),
  effect TEXT NOT NULL CHECK (effect IN ('agent', 'command', 'measurement', 'verification', 'apply')),
  execution_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'stopped', 'cancelled')),
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  resources_json TEXT CHECK (resources_json IS NULL OR json_valid(resources_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (operation_id, number),
  CHECK ((status IN ('running', 'waiting')) = (ended_at IS NULL))
) STRICT;
CREATE INDEX attempts_run_status ON attempts(run_id, status, updated_at);

CREATE TABLE workspace_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  workspace_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  lineage_hash TEXT,
  write_scope_hash TEXT,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX workspace_checkpoints_operation_created ON workspace_checkpoints(operation_id, created_at);

CREATE TABLE scope_calls (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  previous_call_key TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  call_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  completion_authority TEXT NOT NULL CHECK (completion_authority IN ('finish-work', 'host-effect', 'structural-join')),
  replay_policy TEXT NOT NULL CHECK (replay_policy IN ('immutable', 'workspace', 'never')),
  result_hash TEXT NOT NULL,
  post_workspace_checkpoint_id TEXT REFERENCES workspace_checkpoints(checkpoint_id) DEFERRABLE INITIALLY DEFERRED,
  source_run_id TEXT,
  source_operation_id TEXT,
  source_scope_path TEXT,
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_call_key TEXT,
  committed_at TEXT NOT NULL,
  UNIQUE (scope_id, cursor),
  UNIQUE (run_id, call_key),
  CHECK ((source_run_id IS NULL) = (source_operation_id IS NULL)),
  CHECK ((source_run_id IS NULL) = (source_scope_path IS NULL)),
  CHECK ((source_run_id IS NULL) = (source_cursor IS NULL)),
  CHECK ((source_run_id IS NULL) = (source_call_key IS NULL))
) STRICT;
CREATE INDEX scope_calls_scope_cursor ON scope_calls(scope_id, cursor);
CREATE INDEX scope_calls_source ON scope_calls(source_run_id, source_scope_path, source_cursor);

CREATE TABLE structural_joins (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('parallel', 'map', 'candidate')),
  previous_call_key TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  output_order_json TEXT NOT NULL CHECK (json_valid(output_order_json)),
  join_key TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE (scope_id, cursor),
  UNIQUE (run_id, join_key)
) STRICT;

CREATE TABLE structural_join_lanes (
  operation_id TEXT NOT NULL REFERENCES structural_joins(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  lane_key TEXT NOT NULL,
  scope_id TEXT NOT NULL UNIQUE REFERENCES scopes(scope_id) DEFERRABLE INITIALLY DEFERRED,
  terminal_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
  PRIMARY KEY (operation_id, ordinal),
  UNIQUE (operation_id, lane_key)
) STRICT;

CREATE TABLE candidate_workspaces (
  workspace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  body_scope_id TEXT NOT NULL UNIQUE REFERENCES scopes(scope_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  parent_candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  state TEXT NOT NULL CHECK (state IN ('mutable', 'frozen', 'abandoned')),
  initial_tree_hash TEXT NOT NULL,
  base_lineage_hash TEXT NOT NULL,
  write_scope_json TEXT NOT NULL CHECK (json_valid(write_scope_json)),
  write_scope_hash TEXT NOT NULL,
  root_path TEXT NOT NULL,
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (run_id, root_path),
  CHECK ((state = 'mutable') = (ended_at IS NULL)),
  CHECK ((state = 'abandoned') = (failure_json IS NOT NULL))
) STRICT;

CREATE TABLE candidate_workspace_lanes (
  workspace_id TEXT NOT NULL REFERENCES candidate_workspaces(workspace_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  group_operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  lane_key TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, group_operation_id)
) STRICT;

CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES candidate_workspaces(workspace_id) DEFERRABLE INITIALLY DEFERRED,
  body_scope_id TEXT NOT NULL UNIQUE REFERENCES scopes(scope_id) DEFERRABLE INITIALLY DEFERRED,
  parent_candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  tree_hash TEXT NOT NULL,
  lineage_hash TEXT NOT NULL,
  write_scope_hash TEXT NOT NULL,
  output_json TEXT NOT NULL CHECK (json_valid(output_json)),
  output_hash TEXT NOT NULL,
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

CREATE TABLE metric_sets (
  metric_set_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  authority_id TEXT NOT NULL,
  source_site TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  policy_hash TEXT NOT NULL,
  sampling_json TEXT NOT NULL CHECK (json_valid(sampling_json)),
  sampling_hash TEXT NOT NULL,
  states_json TEXT NOT NULL CHECK (json_valid(states_json)),
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, authority_id),
  UNIQUE (run_id, source_site, occurrence)
) STRICT;
CREATE INDEX metric_sets_run_created ON metric_sets(run_id, created_at, metric_set_id);

CREATE TABLE workflow_measurements (
  measurement_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  metric_set_id TEXT NOT NULL REFERENCES metric_sets(metric_set_id) DEFERRABLE INITIALLY DEFERRED,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  profile_hash TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
  environment_hash TEXT NOT NULL,
  workspace_tree_hash TEXT NOT NULL,
  candidate_id TEXT REFERENCES candidates(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  binding_hash TEXT NOT NULL,
  delta_json TEXT NOT NULL CHECK (json_valid(delta_json)),
  observations_json TEXT NOT NULL CHECK (json_valid(observations_json)),
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  diagnostics_artifact_digest TEXT REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX workflow_measurements_metric_created
  ON workflow_measurements(metric_set_id, created_at, measurement_id);
CREATE INDEX workflow_measurements_candidate ON workflow_measurements(candidate_id, measurement_id);

CREATE TABLE candidate_measurements (
  measurement_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(candidate_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  binding_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  CHECK ((status = 'pending') = (finalized_at IS NULL))
) STRICT;

CREATE TABLE workflow_experiments (
  experiment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate_dispositions(candidate_id) DEFERRABLE INITIALLY DEFERRED,
  measurement_id TEXT NOT NULL UNIQUE REFERENCES workflow_measurements(measurement_id) DEFERRABLE INITIALLY DEFERRED,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  learned TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX workflow_experiments_run_created ON workflow_experiments(run_id, created_at, experiment_id);

CREATE TABLE candidate_verifications (
  verification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  binding_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX candidate_verifications_candidate_created ON candidate_verifications(candidate_id, created_at);

CREATE TABLE candidate_dispositions (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected', 'discarded', 'abandoned')),
  authority_hash TEXT NOT NULL,
  verification_id TEXT REFERENCES candidate_verifications(verification_id) DEFERRABLE INITIALLY DEFERRED,
  measurement_id TEXT REFERENCES candidate_measurements(measurement_id) DEFERRABLE INITIALLY DEFERRED,
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  disposed_at TEXT NOT NULL,
  CHECK (disposition <> 'accepted' OR verification_id IS NOT NULL),
  CHECK (disposition = 'accepted' OR reason_json IS NOT NULL)
) STRICT;

CREATE TABLE candidate_applies (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate_dispositions(candidate_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  approval_id TEXT NOT NULL,
  verification_binding_hash TEXT NOT NULL,
  authority_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

PRAGMA user_version = ${WORKFLOW_RUN_DATABASE_SCHEMA_VERSION};
`;
