PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  installation_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'uninstalled', 'unverified')),
  account_login TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installation_repositories (
  installation_id INTEGER NOT NULL REFERENCES installations (installation_id),
  full_name TEXT NOT NULL,
  repository_id INTEGER,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, full_name)
);

CREATE INDEX IF NOT EXISTS installation_repositories_by_name
  ON installation_repositories (lower(full_name), installation_id, active);

CREATE TABLE IF NOT EXISTS tracking_registrations (
  tracking_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES installations (installation_id),
  target_owner TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_full_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  upstream_repository TEXT NOT NULL,
  upstream_ref TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  last_checked_commit TEXT NOT NULL,
  last_synced_commit TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  creation_token TEXT NOT NULL UNIQUE,
  last_synced_job_id TEXT,
  last_synced_job_key TEXT,
  last_synced_merge_commit TEXT,
  UNIQUE (installation_id, target_full_name, base_branch)
);

CREATE INDEX IF NOT EXISTS tracking_registrations_active_page
  ON tracking_registrations (active, tracking_id);

CREATE UNIQUE INDEX IF NOT EXISTS tracking_registrations_identity_unique
  ON tracking_registrations (installation_id, lower(target_full_name), base_branch);

CREATE INDEX IF NOT EXISTS tracking_registrations_by_repository
  ON tracking_registrations (installation_id, lower(target_full_name), base_branch, active);

CREATE TABLE IF NOT EXISTS tracking_schedules (
  tracking_id TEXT PRIMARY KEY REFERENCES tracking_registrations (tracking_id) ON DELETE CASCADE,
  next_due_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tracking_schedules_due
  ON tracking_schedules (next_due_at, tracking_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  installation_id INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_class TEXT NOT NULL CHECK (payload_class IN ('lifecycle', 'event')),
  received_at TEXT NOT NULL,
  expires_at TEXT,
  claim_token TEXT NOT NULL,
  PRIMARY KEY (installation_id, payload_digest)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_expiry
  ON webhook_deliveries (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_deliveries_by_header
  ON webhook_deliveries (installation_id, delivery_id, received_at);

CREATE TABLE IF NOT EXISTS queue_outbox (
  work_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'reconcile')),
  tracking_id TEXT NOT NULL REFERENCES tracking_registrations (tracking_id),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS queue_outbox_pending
  ON queue_outbox (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS checkpoint_activations (
  tracking_id TEXT NOT NULL REFERENCES tracking_registrations (tracking_id),
  job_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  upstream_commit TEXT NOT NULL,
  target_base_commit TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  expected_last_synced_commit TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number >= 1),
  base_branch TEXT NOT NULL,
  merge_commit TEXT NOT NULL,
  observed_base_commit TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  activation_token TEXT NOT NULL UNIQUE,
  PRIMARY KEY (tracking_id, job_id)
);
