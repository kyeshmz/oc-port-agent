import type {
  CheckedCommitAdvance,
  CumulativeRangeJobs,
  CumulativeRangeQuery,
  NewJobRecord,
  NewTrackingRegistration,
  StorePort,
  SyncOriginQuery,
  SyncedCommitActivation,
  TrackingId,
  TrackingRegistration,
  WebhookDelivery,
} from './contracts.js';
import { parsePolicy, policyHash } from './policy.js';

export type D1SqlValue = string | number | null;

export interface D1QueryResult<Row = Record<string, unknown>> {
  success: boolean;
  results: Row[];
  meta?: { changes?: number };
}

export interface D1PreparedStatementBinding {
  bind(...values: D1SqlValue[]): D1PreparedStatementBinding;
  first<Row = Record<string, unknown>>(columnName?: string): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
  run<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
}

/** Structural subset of the D1 binding used here; Wrangler types replace this at deploy integration. */
export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatementBinding;
  batch<Row = Record<string, unknown>>(statements: D1PreparedStatementBinding[]): Promise<D1QueryResult<Row>[]>;
}

export type TrackingStorePort = Pick<StorePort,
  | 'createTrackingRegistration'
  | 'getTrackingRegistration'
  | 'listActiveTrackingRegistrations'
  | 'setTrackingRegistrationActive'
  | 'recordWebhookDelivery'
  | 'advanceLastCheckedCommit'
  | 'activateLastSyncedCommit'
>;

export type DurableJobStorePort = Pick<StorePort,
  | 'createOrGetJob'
  | 'getJob'
  | 'getJobByKey'
  | 'listJobsForCumulativeRange'
  | 'listJobsForSyncOrigin'
  | 'saveJob'
>;

export interface InstallationRepositoryRecord {
  fullName: string;
  repositoryId?: number;
}

export interface WebhookPayloadEvidence {
  /** SHA-256 of the exact HMAC-verified raw body; event/delivery headers are not part of identity. */
  payloadDigest: string;
  payloadClass: 'lifecycle' | 'event';
}

export interface ConfirmedRegistrationRevision {
  trackingId: TrackingId;
  expectedRevision: number;
}

export interface InstallationWebhookUpdate {
  delivery: WebhookDelivery;
  evidence: WebhookPayloadEvidence;
  accountLogin?: string;
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  repositories: readonly InstallationRepositoryRecord[];
  /** Only IDs whose current installation token access was rechecked and denied by the host. */
  confirmedInaccessibleTrackingIds: readonly ConfirmedRegistrationRevision[];
}

export interface InstallationRepositoriesWebhookUpdate {
  delivery: WebhookDelivery;
  evidence: WebhookPayloadEvidence;
  added: readonly InstallationRepositoryRecord[];
  removed: readonly string[];
  /** Only registrations whose target access was freshly rechecked and denied may be suspended. */
  confirmedRemovedTrackingIds: readonly ConfirmedRegistrationRevision[];
}

export interface PullRequestWebhookUpdate {
  delivery: WebhookDelivery;
  evidence: WebhookPayloadEvidence;
  repositoryFullName: string;
  baseBranch: string;
  workPrefix: string;
}

export interface UpstreamPushWebhookUpdate {
  delivery: WebhookDelivery;
  evidence: WebhookPayloadEvidence;
  /** Canonical `https://github.com/<owner>/<name>.git`, matching stored policy upstreams. */
  upstreamRepository: string;
  /** Branches match the stored ref; tags wake all eligible registrations for this repository. */
  pushedRef: { kind: 'branch'; name: string } | { kind: 'tag'; name: string };
  workPrefix: string;
  /** Fallback poll time for every registration this push enqueued. */
  nextDueAt: string;
}

export interface QueueOutboxRecord {
  workId: string;
  kind: QueueWorkMessage['kind'];
  trackingId: TrackingId;
  attempts: number;
}

export type QueueOutboxStore = Pick<D1RegistryStore,
  'listPendingOutbox' | 'markOutboxSent' | 'markOutboxRetry'
>;

export interface QueueWorkMessage {
  version: 1;
  workId: string;
  kind: 'poll' | 'reconcile';
  trackingId: TrackingId;
}

export class StoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
  }
}

const TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const POLICY_HASH = /^[a-f0-9]{64}$/i;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const PAYLOAD_DIGEST = /^[a-f0-9]{64}$/;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  return value.length <= 40 && Number.isFinite(Date.parse(value));
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new StoreError(code);
  return value;
}

function validateRegistrationInput(input: NewTrackingRegistration): string {
  if (!TRACKING_ID.test(input.id) || !Number.isSafeInteger(input.installationId) || input.installationId < 1
    || !REPOSITORY_PART.test(input.target.owner) || !REPOSITORY_PART.test(input.target.name)
    || input.target.fullName.toLowerCase() !== `${input.target.owner}/${input.target.name}`.toLowerCase()
    || !validBranch(input.baseBranch) || !COMMIT_SHA.test(input.upstream.baselineCommit)
    || !POLICY_HASH.test(input.policyHash) || typeof input.active !== 'boolean') {
    throw new StoreError('invalid-registration');
  }
  const policy = parsePolicy(input.policy);
  if (policy.upstream.repository !== input.upstream.repository || policy.upstream.ref !== input.upstream.ref) {
    throw new StoreError('registration-policy-mismatch');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(policy);
  } catch {
    throw new StoreError('invalid-registration-policy');
  }
  if (new TextEncoder().encode(serialized).length > 1_000_000) throw new StoreError('registration-policy-limit');
  return serialized;
}

function validBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 255 && !branch.startsWith('-') && !branch.startsWith('/')
    && !branch.endsWith('/') && !branch.endsWith('.') && !branch.includes('..') && !branch.includes('@{')
    && !branch.includes('//') && !/[ ~^:?*\[\\\x00-\x20\x7f]/.test(branch);
}

function repositoryParts(fullName: string): { owner: string; name: string; fullName: string } {
  if (fullName.length > 500 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new StoreError('invalid-repository-name');
  const slash = fullName.indexOf('/');
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1), fullName };
}

function parseRegistrationRow(row: unknown): TrackingRegistration {
  if (!isRecord(row)) throw new StoreError('corrupt-registration');
  const id = requiredText(row.tracking_id, 'corrupt-registration');
  const installationId = row.installation_id;
  const owner = requiredText(row.target_owner, 'corrupt-registration');
  const name = requiredText(row.target_name, 'corrupt-registration');
  const fullName = requiredText(row.target_full_name, 'corrupt-registration');
  const baseBranch = requiredText(row.base_branch, 'corrupt-registration');
  const upstreamRepository = requiredText(row.upstream_repository, 'corrupt-registration');
  const upstreamRef = requiredText(row.upstream_ref, 'corrupt-registration');
  const baselineCommit = requiredText(row.baseline_commit, 'corrupt-registration');
  const policyHashValue = requiredText(row.policy_hash, 'corrupt-registration');
  const lastCheckedCommit = requiredText(row.last_checked_commit, 'corrupt-registration');
  const lastSyncedCommit = requiredText(row.last_synced_commit, 'corrupt-registration');
  const active = row.active;
  const revision = row.revision;
  if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId < 1
    || typeof active !== 'number' || (active !== 0 && active !== 1)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()
    || !COMMIT_SHA.test(baselineCommit) || !COMMIT_SHA.test(lastCheckedCommit) || !COMMIT_SHA.test(lastSyncedCommit)
    || !POLICY_HASH.test(policyHashValue)) throw new StoreError('corrupt-registration');
  let policy: unknown;
  try {
    policy = JSON.parse(requiredText(row.policy_json, 'corrupt-registration')) as unknown;
  } catch {
    throw new StoreError('corrupt-registration');
  }
  return {
    id,
    installationId,
    target: { owner, name, fullName },
    baseBranch,
    upstream: { repository: upstreamRepository, ref: upstreamRef, baselineCommit },
    policy,
    policyHash: policyHashValue,
    lastCheckedCommit,
    lastSyncedCommit,
    active: active === 1,
    revision,
  };
}

function changes(result: D1QueryResult<unknown> | undefined): number {
  const value = result?.meta?.changes;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function rowCount(result: D1QueryResult<unknown> | undefined): number {
  return Array.isArray(result?.results) ? result.results.length : 0;
}

function validateDelivery(delivery: WebhookDelivery): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(delivery.deliveryId)
    || !Number.isSafeInteger(delivery.installationId) || delivery.installationId < 1
    || !validTimestamp(delivery.receivedAt) || !validTimestamp(delivery.expiresAt)
    || Date.parse(delivery.expiresAt) <= Date.parse(delivery.receivedAt)) throw new StoreError('invalid-webhook-delivery');
}

function validateRepositoryRecord(repository: InstallationRepositoryRecord): void {
  repositoryParts(repository.fullName);
  if (repository.repositoryId !== undefined && (!Number.isSafeInteger(repository.repositoryId) || repository.repositoryId < 1)) {
    throw new StoreError('invalid-installation-repository');
  }
}

function validateWebhookEvidence(evidence: WebhookPayloadEvidence): void {
  if (!PAYLOAD_DIGEST.test(evidence.payloadDigest) || (evidence.payloadClass !== 'lifecycle' && evidence.payloadClass !== 'event')) {
    throw new StoreError('invalid-webhook-payload-evidence');
  }
}

function acceptDeliveryStatement(
  db: D1DatabaseBinding,
  delivery: WebhookDelivery,
  evidence: WebhookPayloadEvidence,
  claimToken: string,
): D1PreparedStatementBinding {
  validateDelivery(delivery);
  validateWebhookEvidence(evidence);
  return db.prepare(`
    INSERT INTO webhook_deliveries (installation_id, delivery_id, payload_digest, payload_class, received_at, expires_at, claim_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (installation_id, payload_digest) DO UPDATE SET
      delivery_id = excluded.delivery_id,
      payload_class = excluded.payload_class,
      received_at = excluded.received_at,
      expires_at = excluded.expires_at,
      claim_token = excluded.claim_token
    WHERE webhook_deliveries.payload_class = 'event'
      AND webhook_deliveries.expires_at IS NOT NULL
      AND webhook_deliveries.expires_at <= excluded.received_at
    RETURNING payload_digest
  `).bind(
    delivery.installationId,
    delivery.deliveryId,
    evidence.payloadDigest,
    evidence.payloadClass,
    delivery.receivedAt,
    evidence.payloadClass === 'lifecycle' ? null : delivery.expiresAt,
    claimToken,
  );
}

function acceptedDeliveryExistsSql(): string {
  return `EXISTS (
    SELECT 1 FROM webhook_deliveries
    WHERE installation_id = ? AND payload_digest = ? AND claim_token = ?
  )`;
}

function activeRegistrationRow(row: unknown): TrackingRegistration {
  return parseRegistrationRow(row);
}

export class D1RegistryStore implements TrackingStorePort {
  constructor(private readonly db: D1DatabaseBinding, private readonly now: () => string = () => new Date().toISOString()) {}

  async createTrackingRegistration(input: NewTrackingRegistration): Promise<TrackingRegistration> {
    const policy = parsePolicy(input.policy);
    const digest = await policyHash(policy);
    if (policy.upstream.repository !== input.upstream.repository || policy.upstream.ref !== input.upstream.ref
      || digest !== input.policyHash.toLowerCase()) throw new StoreError('registration-policy-mismatch');
    const policyJson = validateRegistrationInput({ ...input, policy });
    const createdAt = this.now();
    if (!validTimestamp(createdAt)) throw new StoreError('invalid-store-clock');
    const creationToken = crypto.randomUUID();
    const values: D1SqlValue[] = [
      input.id,
      input.installationId,
      input.target.owner,
      input.target.name,
      input.target.fullName,
      input.baseBranch,
      input.upstream.repository,
      input.upstream.ref,
      input.upstream.baselineCommit,
      policyJson,
      input.policyHash.toLowerCase(),
      input.upstream.baselineCommit,
      input.upstream.baselineCommit,
      input.active ? 1 : 0,
      createdAt,
      createdAt,
      creationToken,
      input.installationId,
      input.target.fullName.toLowerCase(),
    ];
    const installationUpsert = this.db.prepare(`
      INSERT INTO installations (installation_id, status, account_login, updated_at)
      VALUES (?, 'active', NULL, ?)
      ON CONFLICT (installation_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
    `).bind(input.installationId, createdAt);
    const repositoryUpsert = this.db.prepare(`
      INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at)
      SELECT installation_id, ?, NULL, 1, ? FROM installations WHERE installation_id = ? AND status = 'active'
      ON CONFLICT (installation_id, full_name) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `).bind(input.target.fullName.toLowerCase(), createdAt, input.installationId);
    const registrationInsert = this.db.prepare(`
      INSERT INTO tracking_registrations (
        tracking_id, installation_id, target_owner, target_name, target_full_name, base_branch,
        upstream_repository, upstream_ref, baseline_commit, policy_json, policy_hash,
        last_checked_commit, last_synced_commit, active, revision, created_at, updated_at, creation_token
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM installations i
        JOIN installation_repositories r ON r.installation_id = i.installation_id
        WHERE i.installation_id = ? AND i.status = 'active' AND r.active = 1 AND lower(r.full_name) = ?
      )
      RETURNING tracking_id
    `).bind(...values);
    const scheduleInsert = this.db.prepare(`
      INSERT INTO tracking_schedules (tracking_id, next_due_at)
      SELECT tracking_id, created_at FROM tracking_registrations
      WHERE tracking_id = ? AND creation_token = ?
    `).bind(input.id, creationToken);
    let result: D1QueryResult<unknown>[];
    try {
      result = await this.db.batch([installationUpsert, repositoryUpsert, registrationInsert, scheduleInsert]);
    } catch {
      throw new StoreError('registration-conflict-or-inactive-installation');
    }
    if (rowCount(result[2]) !== 1) throw new StoreError('registration-conflict-or-inactive-installation');
    const stored = await this.getTrackingRegistration(input.id);
    if (!stored) throw new StoreError('registration-persist-failed');
    return stored;
  }

  async getTrackingRegistration(trackingId: TrackingId): Promise<TrackingRegistration | undefined> {
    if (!TRACKING_ID.test(trackingId)) return undefined;
    const row = await this.db.prepare('SELECT * FROM tracking_registrations WHERE tracking_id = ? LIMIT 1')
      .bind(trackingId).first<unknown>();
    return row === null ? undefined : parseRegistrationRow(row);
  }

  async listActiveTrackingRegistrations(input: { limit: number; cursor?: string }): Promise<{
    registrations: readonly TrackingRegistration[];
    nextCursor?: string;
  }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500
      || (input.cursor !== undefined && !TRACKING_ID.test(input.cursor))) throw new StoreError('invalid-registration-page');
    const cursor = input.cursor ?? '';
    const result = await this.db.prepare(`
      SELECT t.* FROM tracking_registrations t
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE t.active = 1 AND t.tracking_id > ?
      ORDER BY t.tracking_id COLLATE BINARY
      LIMIT ?
    `).bind(cursor, input.limit + 1).all<unknown>();
    if (!result.success || !Array.isArray(result.results)) throw new StoreError('registration-list-failed');
    const hasMore = result.results.length > input.limit;
    const rows = result.results.slice(0, input.limit);
    const registrations = rows.map(activeRegistrationRow);
    const last = rows.at(-1);
    let nextCursor: string | undefined;
    if (hasMore) {
      if (!last || !isRecord(last)) throw new StoreError('corrupt-registration-page');
      nextCursor = requiredText(last.tracking_id, 'corrupt-registration');
    }
    return {
      registrations,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async isTrackingEligible(trackingId: TrackingId): Promise<boolean> {
    if (!TRACKING_ID.test(trackingId)) return false;
    const row = await this.db.prepare(`
      SELECT 1 AS eligible FROM tracking_registrations t
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE t.tracking_id = ? AND t.active = 1 LIMIT 1
    `).bind(trackingId).first<unknown>();
    return row !== null;
  }

  async setTrackingRegistrationActive(input: { trackingId: TrackingId; expectedRevision: number; active: boolean }): Promise<boolean> {
    if (!TRACKING_ID.test(input.trackingId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return false;
    const timestamp = this.now();
    if (!validTimestamp(timestamp)) throw new StoreError('invalid-store-clock');
    const update = this.db.prepare(`
      UPDATE tracking_registrations
      SET active = ?, revision = revision + 1, updated_at = ?
      WHERE tracking_id = ? AND revision = ?
        AND (? = 0 OR EXISTS (
          SELECT 1 FROM installations i JOIN installation_repositories r
            ON r.installation_id = i.installation_id
          WHERE i.installation_id = tracking_registrations.installation_id AND i.status = 'active'
            AND r.active = 1 AND lower(r.full_name) = lower(tracking_registrations.target_full_name)
        ))
      RETURNING tracking_id
    `).bind(input.active ? 1 : 0, timestamp, input.trackingId, input.expectedRevision, input.active ? 1 : 0);
    const schedule = this.db.prepare(`
      UPDATE tracking_schedules SET next_due_at = ?
      WHERE tracking_id = ? AND EXISTS (
        SELECT 1 FROM tracking_registrations WHERE tracking_id = ? AND revision = ? AND active = 1
      )
    `).bind(timestamp, input.trackingId, input.trackingId, input.expectedRevision + 1);
    if (!input.active) {
      const results = await this.db.batch([update, schedule]);
      return rowCount(results[0]) === 1;
    }
    const install = this.db.prepare(`
      INSERT INTO installations (installation_id, status, account_login, updated_at)
      SELECT installation_id, 'active', NULL, ? FROM tracking_registrations
      WHERE tracking_id = ? AND revision = ?
      ON CONFLICT (installation_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
    `).bind(timestamp, input.trackingId, input.expectedRevision);
    const repository = this.db.prepare(`
      INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at)
      SELECT installation_id, lower(target_full_name), NULL, 1, ? FROM tracking_registrations
      WHERE tracking_id = ? AND revision = ?
      ON CONFLICT (installation_id, full_name) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `).bind(timestamp, input.trackingId, input.expectedRevision);
    const results = await this.db.batch([install, repository, update, schedule]);
    return rowCount(results[2]) === 1;
  }

  async recordWebhookDelivery(input: WebhookDelivery, evidence?: WebhookPayloadEvidence): Promise<boolean> {
    validateDelivery(input);
    if (!evidence) throw new StoreError('verified-webhook-payload-required');
    const result = await acceptDeliveryStatement(this.db, input, evidence, crypto.randomUUID()).first<unknown>();
    return result !== null;
  }

  async applyInstallationWebhook(input: InstallationWebhookUpdate): Promise<boolean> {
    validateDelivery(input.delivery);
    validateWebhookEvidence(input.evidence);
    if (input.evidence.payloadClass !== 'lifecycle') throw new StoreError('invalid-webhook-payload-class');
    if (input.accountLogin !== undefined && (!REPOSITORY_PART.test(input.accountLogin) || input.accountLogin.length > 100)) {
      throw new StoreError('invalid-installation-account');
    }
    if (input.repositories.length > 100 || input.confirmedInaccessibleTrackingIds.length > 100
      || input.confirmedInaccessibleTrackingIds.some(item => !TRACKING_ID.test(item.trackingId)
        || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1)) throw new StoreError('installation-repository-event-limit');
    for (const repository of input.repositories) validateRepositoryRecord(repository);
    const claim = crypto.randomUUID();
    const login = input.accountLogin ?? null;
    const statements: D1PreparedStatementBinding[] = [
      acceptDeliveryStatement(this.db, input.delivery, input.evidence, claim),
    ];
    if (input.action === 'created') {
      statements.push(this.db.prepare(`
        INSERT INTO installations (installation_id, status, account_login, updated_at)
        SELECT ?, 'unverified', ?, ? WHERE ${acceptedDeliveryExistsSql()}
        ON CONFLICT (installation_id) DO NOTHING
      `).bind(input.delivery.installationId, login, input.delivery.receivedAt,
        input.delivery.installationId, input.evidence.payloadDigest, claim));
      for (const repository of input.repositories) {
        const parts = repositoryParts(repository.fullName);
        statements.push(this.db.prepare(`
          INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at)
          SELECT ?, ?, ?, 0, ? WHERE ${acceptedDeliveryExistsSql()}
          ON CONFLICT (installation_id, full_name) DO NOTHING
        `).bind(input.delivery.installationId, parts.fullName.toLowerCase(), repository.repositoryId ?? null,
          input.delivery.receivedAt, input.delivery.installationId, input.evidence.payloadDigest, claim));
      }
    }
    if (input.action === 'deleted' || input.action === 'suspend' || input.action === 'new_permissions_accepted') {
      for (const confirmed of input.confirmedInaccessibleTrackingIds) {
        statements.push(this.db.prepare(`
          UPDATE tracking_registrations SET active = 0, revision = revision + 1, updated_at = ?
          WHERE tracking_id = ? AND installation_id = ? AND revision = ? AND active = 1 AND ${acceptedDeliveryExistsSql()}
        `).bind(input.delivery.receivedAt, confirmed.trackingId, input.delivery.installationId, confirmed.expectedRevision,
          input.delivery.installationId, input.evidence.payloadDigest, claim));
      }
    }
    const result = await this.db.batch(statements);
    return rowCount(result[0]) === 1;
  }

  async applyInstallationRepositoriesWebhook(input: InstallationRepositoriesWebhookUpdate): Promise<boolean> {
    validateDelivery(input.delivery);
    validateWebhookEvidence(input.evidence);
    if (input.evidence.payloadClass !== 'lifecycle' || input.added.length > 100 || input.removed.length > 100
      || input.confirmedRemovedTrackingIds.length > 100
      || input.confirmedRemovedTrackingIds.some(item => !TRACKING_ID.test(item.trackingId)
        || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1)) throw new StoreError('installation-repository-event-limit');
    for (const repository of input.added) validateRepositoryRecord(repository);
    for (const fullName of input.removed) repositoryParts(fullName);
    const claim = crypto.randomUUID();
    const statements: D1PreparedStatementBinding[] = [acceptDeliveryStatement(this.db, input.delivery, input.evidence, claim)];
    for (const repository of input.added) {
      const parts = repositoryParts(repository.fullName);
      statements.push(this.db.prepare(`
        INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at)
        SELECT ?, ?, ?, 0, ?
        WHERE ${acceptedDeliveryExistsSql()}
        ON CONFLICT (installation_id, full_name) DO NOTHING
      `).bind(input.delivery.installationId, parts.fullName.toLowerCase(), repository.repositoryId ?? null,
        input.delivery.receivedAt, input.delivery.installationId, input.evidence.payloadDigest, claim));
    }
    const removed = new Set(input.removed.map(fullName => fullName.toLowerCase()));
    for (const confirmed of input.confirmedRemovedTrackingIds) {
      const registration = await this.getTrackingRegistration(confirmed.trackingId);
      if (!registration || registration.installationId !== input.delivery.installationId
        || registration.revision !== confirmed.expectedRevision
        || !removed.has(registration.target.fullName.toLowerCase())) continue;
      const normalized = registration.target.fullName.toLowerCase();
      statements.push(this.db.prepare(`
        UPDATE installation_repositories SET active = 0, updated_at = ?
        WHERE installation_id = ? AND lower(full_name) = ? AND ${acceptedDeliveryExistsSql()}
          AND EXISTS (
            SELECT 1 FROM tracking_registrations t
            WHERE t.tracking_id = ? AND t.installation_id = ? AND t.revision = ? AND t.active = 1
              AND lower(t.target_full_name) = lower(installation_repositories.full_name)
          )
      `).bind(input.delivery.receivedAt, input.delivery.installationId, normalized,
        input.delivery.installationId, input.evidence.payloadDigest, claim,
        confirmed.trackingId, input.delivery.installationId, confirmed.expectedRevision));
      statements.push(this.db.prepare(`
        UPDATE tracking_registrations SET active = 0, revision = revision + 1, updated_at = ?
        WHERE tracking_id = ? AND installation_id = ? AND revision = ? AND lower(target_full_name) = ? AND active = 1
          AND ${acceptedDeliveryExistsSql()}
      `).bind(input.delivery.receivedAt, confirmed.trackingId, input.delivery.installationId, confirmed.expectedRevision, normalized,
        input.delivery.installationId, input.evidence.payloadDigest, claim));
    }
    const result = await this.db.batch(statements);
    return rowCount(result[0]) === 1;
  }

  async enqueueMergedPullRequestReconciliation(input: PullRequestWebhookUpdate): Promise<boolean> {
    validateDelivery(input.delivery);
    validateWebhookEvidence(input.evidence);
    if (input.evidence.payloadClass !== 'event') throw new StoreError('invalid-webhook-payload-class');
    const repository = repositoryParts(input.repositoryFullName);
    if (!validBranch(input.baseBranch) || !/^hook_[a-f0-9]{64}$/i.test(input.workPrefix)) throw new StoreError('invalid-reconciliation-work');
    const claim = crypto.randomUUID();
    const insert = this.db.prepare(`
      INSERT INTO queue_outbox (work_id, kind, tracking_id, created_at, status, attempts, next_attempt_at)
      SELECT ? || ':' || t.tracking_id, 'reconcile', t.tracking_id, ?, 'pending', 0, ?
      FROM tracking_registrations t
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE t.installation_id = ? AND lower(t.target_full_name) = ? AND t.base_branch = ? AND t.active = 1
        AND ${acceptedDeliveryExistsSql()}
      ON CONFLICT (work_id) DO NOTHING
    `).bind(input.workPrefix, input.delivery.receivedAt, input.delivery.receivedAt,
      input.delivery.installationId, repository.fullName.toLowerCase(), input.baseBranch,
      input.delivery.installationId, input.evidence.payloadDigest, claim);
    const result = await this.db.batch([acceptDeliveryStatement(this.db, input.delivery, input.evidence, claim), insert]);
    return rowCount(result[0]) === 1;
  }

  async enqueueUpstreamPushPolls(input: UpstreamPushWebhookUpdate): Promise<boolean> {
    validateDelivery(input.delivery);
    validateWebhookEvidence(input.evidence);
    if (input.evidence.payloadClass !== 'event') throw new StoreError('invalid-webhook-payload-class');
    if (input.upstreamRepository.length > 600
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.upstreamRepository)
      || !['branch', 'tag'].includes(input.pushedRef.kind) || !validBranch(input.pushedRef.name)
      || input.pushedRef.name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
      || !/^hook_[a-f0-9]{64}$/i.test(input.workPrefix)
      || !validTimestamp(input.nextDueAt)) throw new StoreError('invalid-push-poll-work');
    const claim = crypto.randomUUID();
    const insert = this.db.prepare(`
      INSERT INTO queue_outbox (work_id, kind, tracking_id, created_at, status, attempts, next_attempt_at)
      SELECT ? || ':' || t.tracking_id, 'poll', t.tracking_id, ?, 'pending', 0, ?
      FROM tracking_registrations t
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE lower(t.upstream_repository) = lower(?) AND (? = 'tag' OR t.upstream_ref = ?) AND t.active = 1
        AND ${acceptedDeliveryExistsSql()}
      ON CONFLICT (work_id) DO NOTHING
    `).bind(input.workPrefix, input.delivery.receivedAt, input.delivery.receivedAt,
      input.upstreamRepository, input.pushedRef.kind, input.pushedRef.name,
      input.delivery.installationId, input.evidence.payloadDigest, claim);
    const postpone = this.db.prepare(`
      UPDATE tracking_schedules SET next_due_at = ?
      WHERE next_due_at < ?
        AND EXISTS (SELECT 1 FROM queue_outbox q WHERE q.work_id = ? || ':' || tracking_schedules.tracking_id)
        AND ${acceptedDeliveryExistsSql()}
    `).bind(input.nextDueAt, input.nextDueAt, input.workPrefix,
      input.delivery.installationId, input.evidence.payloadDigest, claim);
    const result = await this.db.batch([
      acceptDeliveryStatement(this.db, input.delivery, input.evidence, claim),
      insert,
      postpone,
    ]);
    return rowCount(result[0]) === 1;
  }

  async enqueueWork(input: {
    workId: string;
    kind: QueueWorkMessage['kind'];
    trackingId: TrackingId;
    createdAt: string;
  }): Promise<boolean> {
    if (!WORK_ID.test(input.workId) || !TRACKING_ID.test(input.trackingId) || !validTimestamp(input.createdAt)) {
      throw new StoreError('invalid-queue-work');
    }
    const result = await this.db.prepare(`
      INSERT INTO queue_outbox (work_id, kind, tracking_id, created_at, status, attempts, next_attempt_at)
      SELECT ?, ?, t.tracking_id, ?, 'pending', 0, ?
      FROM tracking_registrations t
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE t.tracking_id = ? AND t.active = 1
      ON CONFLICT (work_id) DO NOTHING
      RETURNING work_id
    `).bind(input.workId, input.kind, input.createdAt, input.createdAt, input.trackingId).first<unknown>();
    return result !== null;
  }

  async enqueueDuePolls(input: { now: string; nextDueAt: string; limit: number }): Promise<number> {
    if (!validTimestamp(input.now) || !validTimestamp(input.nextDueAt)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new StoreError('invalid-scheduler-batch');
    const insert = this.db.prepare(`
      INSERT INTO queue_outbox (work_id, kind, tracking_id, created_at, status, attempts, next_attempt_at)
      SELECT 'poll:' || t.tracking_id || ':' || s.next_due_at, 'poll', t.tracking_id, ?, 'pending', 0, ?
      FROM tracking_schedules s
      JOIN tracking_registrations t ON t.tracking_id = s.tracking_id AND t.active = 1
      JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
      JOIN installation_repositories r ON r.installation_id = t.installation_id
        AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
      WHERE s.next_due_at <= ?
      ORDER BY s.next_due_at, t.tracking_id
      LIMIT ?
      ON CONFLICT (work_id) DO NOTHING
    `).bind(input.now, input.now, input.now, input.limit);
    const advance = this.db.prepare(`
      UPDATE tracking_schedules SET next_due_at = ?
      WHERE tracking_id IN (
        SELECT t.tracking_id
        FROM tracking_schedules s
        JOIN tracking_registrations t ON t.tracking_id = s.tracking_id AND t.active = 1
        JOIN installations i ON i.installation_id = t.installation_id AND i.status = 'active'
        JOIN installation_repositories r ON r.installation_id = t.installation_id
          AND lower(r.full_name) = lower(t.target_full_name) AND r.active = 1
        WHERE s.next_due_at <= ?
          AND EXISTS (
            SELECT 1 FROM queue_outbox q
            WHERE q.work_id = 'poll:' || t.tracking_id || ':' || s.next_due_at
          )
        ORDER BY s.next_due_at, t.tracking_id
        LIMIT ?
      )
    `).bind(input.nextDueAt, input.now, input.limit);
    const result = await this.db.batch([insert, advance]);
    return changes(result[1]);
  }

  async listPendingOutbox(input: { now: string; limit: number }): Promise<readonly QueueOutboxRecord[]> {
    if (!validTimestamp(input.now) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new StoreError('invalid-outbox-page');
    }
    const result = await this.db.prepare(`
      SELECT work_id, kind, tracking_id, attempts FROM queue_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at, work_id LIMIT ?
    `).bind(input.now, input.limit).all<unknown>();
    if (!result.success || !Array.isArray(result.results)) throw new StoreError('outbox-list-failed');
    return result.results.map(row => {
      if (!isRecord(row) || typeof row.work_id !== 'string' || !WORK_ID.test(row.work_id)
        || (row.kind !== 'poll' && row.kind !== 'reconcile') || typeof row.tracking_id !== 'string'
        || !TRACKING_ID.test(row.tracking_id) || typeof row.attempts !== 'number' || !Number.isSafeInteger(row.attempts)) {
        throw new StoreError('corrupt-outbox-record');
      }
      return { workId: row.work_id, kind: row.kind, trackingId: row.tracking_id, attempts: row.attempts };
    });
  }

  async markOutboxSent(workId: string, sentAt: string): Promise<boolean> {
    if (!WORK_ID.test(workId) || !validTimestamp(sentAt)) return false;
    const result = await this.db.prepare(`
      UPDATE queue_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1
      WHERE work_id = ? AND status = 'pending' RETURNING work_id
    `).bind(sentAt, workId).first<unknown>();
    return result !== null;
  }

  async markOutboxRetry(workId: string, nextAttemptAt: string): Promise<boolean> {
    if (!WORK_ID.test(workId) || !validTimestamp(nextAttemptAt)) return false;
    const result = await this.db.prepare(`
      UPDATE queue_outbox SET attempts = attempts + 1, next_attempt_at = ?
      WHERE work_id = ? AND status = 'pending' RETURNING work_id
    `).bind(nextAttemptAt, workId).first<unknown>();
    return result !== null;
  }

  async pruneExpiredRecords(input: { now: string; limit: number }): Promise<void> {
    if (!validTimestamp(input.now) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new StoreError('invalid-cleanup-batch');
    }
    const cutoff = new Date(Date.parse(input.now) - DELIVERY_RETENTION_MS).toISOString();
    await this.db.batch([
      this.db.prepare(`
        DELETE FROM webhook_deliveries
        WHERE rowid IN (
          SELECT rowid FROM webhook_deliveries WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
        )
      `).bind(input.now, input.limit),
      this.db.prepare(`
        DELETE FROM queue_outbox
        WHERE rowid IN (
          SELECT rowid FROM queue_outbox WHERE status = 'sent' AND sent_at <= ? ORDER BY sent_at LIMIT ?
        )
      `).bind(cutoff, input.limit),
    ]);
  }

  async advanceLastCheckedCommit(input: CheckedCommitAdvance): Promise<boolean> {
    if (!TRACKING_ID.test(input.trackingId) || !COMMIT_SHA.test(input.expectedLastCheckedCommit)
      || !COMMIT_SHA.test(input.nextLastCheckedCommit) || !POLICY_HASH.test(input.policyHash)) return false;
    const timestamp = this.now();
    if (!validTimestamp(timestamp)) throw new StoreError('invalid-store-clock');
    const row = await this.db.prepare(`
      UPDATE tracking_registrations
      SET last_checked_commit = ?,
          revision = revision + CASE WHEN last_checked_commit = ? THEN 0 ELSE 1 END,
          updated_at = ?
      WHERE tracking_id = ? AND active = 1 AND policy_hash = ?
        AND last_checked_commit IN (?, ?)
        AND EXISTS (SELECT 1 FROM installations i WHERE i.installation_id = tracking_registrations.installation_id AND i.status = 'active')
        AND EXISTS (SELECT 1 FROM installation_repositories r WHERE r.installation_id = tracking_registrations.installation_id
          AND lower(r.full_name) = lower(tracking_registrations.target_full_name) AND r.active = 1)
      RETURNING tracking_id
    `).bind(input.nextLastCheckedCommit, input.nextLastCheckedCommit, timestamp,
      input.trackingId, input.policyHash.toLowerCase(), input.expectedLastCheckedCommit, input.nextLastCheckedCommit).first<unknown>();
    return row !== null;
  }

  async activateLastSyncedCommit(input: SyncedCommitActivation): Promise<boolean> {
    const { candidate, merge } = input;
    if (!TRACKING_ID.test(input.trackingId) || candidate.trackingId !== input.trackingId
      || !TRACKING_ID.test(candidate.jobId) || !WORK_ID.test(candidate.jobKey)
      || !COMMIT_SHA.test(candidate.upstreamCommit) || !COMMIT_SHA.test(candidate.targetBaseCommit)
      || !COMMIT_SHA.test(input.expectedLastSyncedCommit) || !POLICY_HASH.test(candidate.policyHash)
      || candidate.expectedLastSyncedCommit !== input.expectedLastSyncedCommit
      || merge.trackingId !== input.trackingId || merge.jobId !== candidate.jobId
      || merge.baseBranch.length < 1 || merge.baseBranch.length > 255
      || merge.upstreamCommit !== candidate.upstreamCommit || merge.targetBaseCommit !== candidate.targetBaseCommit
      || !COMMIT_SHA.test(merge.observedBaseCommit) || !COMMIT_SHA.test(merge.mergeCommit)
      || !Number.isSafeInteger(merge.pullRequestNumber) || merge.pullRequestNumber < 1
      || !validTimestamp(merge.observedAt)) return false;

    const prior = await this.db.prepare(`
      SELECT * FROM checkpoint_activations WHERE tracking_id = ? AND job_id = ? AND job_key = ? LIMIT 1
    `).bind(input.trackingId, candidate.jobId, candidate.jobKey).first<unknown>();
    if (prior !== null) return this.activationMatches(prior, input);

    const timestamp = this.now();
    const claim = crypto.randomUUID();
    const update = this.db.prepare(`
      UPDATE tracking_registrations
      SET last_synced_commit = ?, revision = revision + 1, updated_at = ?,
          last_synced_job_id = ?, last_synced_job_key = ?, last_synced_merge_commit = ?
      WHERE tracking_id = ? AND active = 1 AND policy_hash = ? AND last_synced_commit = ?
        AND base_branch = ?
        AND EXISTS (SELECT 1 FROM installations i WHERE i.installation_id = tracking_registrations.installation_id AND i.status = 'active')
        AND EXISTS (SELECT 1 FROM installation_repositories r WHERE r.installation_id = tracking_registrations.installation_id
          AND lower(r.full_name) = lower(tracking_registrations.target_full_name) AND r.active = 1)
      RETURNING tracking_id
    `).bind(candidate.upstreamCommit, timestamp, candidate.jobId, candidate.jobKey, merge.mergeCommit,
      input.trackingId, candidate.policyHash.toLowerCase(), input.expectedLastSyncedCommit, merge.baseBranch);
    const insert = this.db.prepare(`
      INSERT INTO checkpoint_activations (
        tracking_id, job_id, job_key, upstream_commit, target_base_commit, policy_hash,
        expected_last_synced_commit, pull_request_number, base_branch, merge_commit,
        observed_base_commit, observed_at, activation_token
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tracking_registrations
        WHERE tracking_id = ? AND last_synced_commit = ? AND last_synced_job_id = ?
          AND last_synced_job_key = ? AND last_synced_merge_commit = ?
      )
      ON CONFLICT (tracking_id, job_id) DO NOTHING
    `).bind(input.trackingId, candidate.jobId, candidate.jobKey, candidate.upstreamCommit, candidate.targetBaseCommit,
      candidate.policyHash.toLowerCase(), input.expectedLastSyncedCommit, merge.pullRequestNumber, merge.baseBranch,
      merge.mergeCommit, merge.observedBaseCommit, merge.observedAt, claim,
      input.trackingId, candidate.upstreamCommit, candidate.jobId, candidate.jobKey, merge.mergeCommit);
    await this.db.batch([update, insert]);
    const saved = await this.db.prepare('SELECT * FROM checkpoint_activations WHERE tracking_id = ? AND job_id = ? LIMIT 1')
      .bind(input.trackingId, candidate.jobId).first<unknown>();
    return saved !== null && this.activationMatches(saved, input);
  }

  private activationMatches(row: unknown, input: SyncedCommitActivation): boolean {
    if (!isRecord(row)) return false;
    const { candidate, merge } = input;
    return row.tracking_id === input.trackingId && row.job_id === candidate.jobId && row.job_key === candidate.jobKey
      && row.upstream_commit === candidate.upstreamCommit && row.target_base_commit === candidate.targetBaseCommit
      && row.policy_hash === candidate.policyHash.toLowerCase()
      && row.expected_last_synced_commit === input.expectedLastSyncedCommit
      && row.pull_request_number === merge.pullRequestNumber && row.base_branch === merge.baseBranch
      && row.merge_commit === merge.mergeCommit && row.observed_base_commit === merge.observedBaseCommit
      && row.observed_at === merge.observedAt;
  }
}

/** Queue work is an outbox effect; this helper marks sent only after Queue.send succeeds. */
export async function flushQueueOutbox(input: {
  store: QueueOutboxStore;
  queue: { send(message: QueueWorkMessage): Promise<void> };
  now?: () => number;
  limit?: number;
}): Promise<{ sent: number; deferred: number }> {
  const now = input.now ?? Date.now;
  const batch = await input.store.listPendingOutbox({
    now: new Date(now()).toISOString(),
    limit: input.limit ?? 100,
  });
  let sent = 0;
  let deferred = 0;
  for (const item of batch) {
    const message: QueueWorkMessage = {
      version: 1,
      workId: item.workId,
      kind: item.kind,
      trackingId: item.trackingId,
    };
    try {
      await input.queue.send(message);
      await input.store.markOutboxSent(item.workId, new Date(now()).toISOString());
      sent++;
    } catch {
      const delaySeconds = Math.min(3_600, 30 * 2 ** Math.min(item.attempts, 7));
      await input.store.markOutboxRetry(item.workId, new Date(now() + delaySeconds * 1_000).toISOString());
      deferred++;
    }
  }
  return { sent, deferred };
}

/** Combines D1 registration/checkpoint state with job details stored by a target Durable Object. */
export class D1Store implements StorePort {
  constructor(private readonly registry: D1RegistryStore, private readonly jobs: DurableJobStorePort) {}

  createTrackingRegistration(input: NewTrackingRegistration): Promise<TrackingRegistration> { return this.registry.createTrackingRegistration(input); }
  getTrackingRegistration(trackingId: TrackingId): Promise<TrackingRegistration | undefined> { return this.registry.getTrackingRegistration(trackingId); }
  listActiveTrackingRegistrations(input: { limit: number; cursor?: string }) { return this.registry.listActiveTrackingRegistrations(input); }
  setTrackingRegistrationActive(input: { trackingId: TrackingId; expectedRevision: number; active: boolean }): Promise<boolean> {
    return this.registry.setTrackingRegistrationActive(input);
  }
  recordWebhookDelivery(input: WebhookDelivery, evidence?: WebhookPayloadEvidence): Promise<boolean> {
    return this.registry.recordWebhookDelivery(input, evidence);
  }
  createOrGetJob(input: NewJobRecord) { return this.jobs.createOrGetJob(input); }
  getJob(jobId: string) { return this.jobs.getJob(jobId); }
  getJobByKey(jobKey: string) { return this.jobs.getJobByKey(jobKey); }
  listJobsForCumulativeRange(input: CumulativeRangeQuery): Promise<CumulativeRangeJobs> {
    return this.jobs.listJobsForCumulativeRange(input);
  }
  listJobsForSyncOrigin(input: SyncOriginQuery): Promise<CumulativeRangeJobs> {
    return this.jobs.listJobsForSyncOrigin(input);
  }
  saveJob(record: Parameters<StorePort['saveJob']>[0], expectedVersion: number) { return this.jobs.saveJob(record, expectedVersion); }
  advanceLastCheckedCommit(input: CheckedCommitAdvance): Promise<boolean> { return this.registry.advanceLastCheckedCommit(input); }
  activateLastSyncedCommit(input: SyncedCommitActivation): Promise<boolean> { return this.registry.activateLastSyncedCommit(input); }
}

// Imported here to make the policy hash check explicit in the module's public dependency surface.
export async function matchesValidatedPolicyHash(policyValue: unknown, expectedHash: string): Promise<boolean> {
  if (!POLICY_HASH.test(expectedHash)) return false;
  try {
    return await policyHash(parsePolicy(policyValue)) === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}
