-- Shared public GitHub hints. Subscribers are derived from eligible registrations,
-- never from an upstream installation or a second subscription registry.
CREATE TABLE upstream_feed_watches (
  watch_id INTEGER PRIMARY KEY,
  repository TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('branch', 'tags')),
  ref TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  body_digest TEXT,
  next_due_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  wake_revision INTEGER,
  lease_token TEXT,
  lease_until TEXT,
  observation_token TEXT,
  UNIQUE (repository, kind, ref)
);
CREATE INDEX upstream_feed_due ON upstream_feed_watches(next_due_at, watch_id);
CREATE INDEX tracking_registrations_feed_subscribers
  ON tracking_registrations(lower(upstream_repository), active, upstream_ref);
