import { DurableObject } from 'cloudflare:workers';
import type {
  CorePorts,
  CumulativeRangeJobs,
  CumulativeRangeQuery,
  DraftPublication,
  GitHubPort,
  JobRecord,
  JobStatus,
  JobStage,
  JobRunResult,
  NewJobRecord,
  PinnedPlan,
  RunnerRequest,
  StorePort,
  SyncOriginQuery,
  TrackingRegistration,
  VerifiedJobProposal,
} from './contracts.js';
import { runJob as runCoreJob, activateConfirmedCheckpoint, CoreError } from './core.js';
import { GitHubAppClient } from './github.js';
import { OpenCodeAgent, createOpenCodeAgent } from './opencode.js';
import {
  D1RegistryStore,
  D1Store,
  type D1DatabaseBinding,
  type DurableJobStorePort,
} from './store.js';
import { createSandboxRunner, type SandboxNamespace } from './sandbox.js';
import { parsePolicy } from './policy.js';
import type { OpenCodeWorkerd } from '@opencode/sdk/workerd';
import { resolveHostedProviderEnvironment, type HostedProviderEnvironment } from './provider.js';

const JOB_TABLE = 'ocpa_job_records';
const EFFECT_TABLE = 'ocpa_job_publication_effects';
const IDENTITY_TABLE = 'ocpa_job_target_identity';
const CLEANUP_TABLE = 'ocpa_job_cleanup_requests';
const SESSION_CLEANUP_TABLE = 'ocpa_session_cleanup_requests';
const RUN_TABLE = 'ocpa_active_run';
const RECONCILE_CURSOR_TABLE = 'ocpa_reconcile_cursors';
const RECONCILE_SWEEP_TABLE = 'ocpa_reconcile_sweep';
const WORK_CURSOR_TABLE = 'ocpa_work_cursors';
const MAX_JOB_RECORD_BYTES = 8_000_000;
const MAX_PUBLICATION_ATTEMPTS = 5;
const JOB_ALARM_GRACE_MS = 60_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 3_600_000;
const LIFECYCLE_RECHECK_MIN_MS = 5 * 60_000;
const PUBLICATION_LEASE_MS = 3 * 60_000;
const PUBLICATION_WAIT_LIMIT_MS = 120_000;
const MAX_INIT_WAIT_MS = 20_000;
const MAX_POLICY_JOB_SECONDS = 7_200;
const RECONCILE_PAGE_SIZE = 8;
const RECONCILE_TRACKING_PAGE_SIZE = 4;
const RECONCILE_PAGES_PER_CALL = 2;
const CANCEL_CLEANUP_WAIT_MS = 5_000;
const RUNNING_STATUSES: readonly JobStatus[] = ['queued', 'running'];
const PUBLICATION_STATUSES: readonly JobStatus[] = ['ready-to-publish', 'publishing'];
const ALL_STATUSES: readonly JobStatus[] = [
  'queued', 'running', 'ready-to-publish', 'publishing', 'published', 'merged',
  'no-op', 'blocked', 'failed', 'cancelled',
];
const ALL_STAGES: readonly JobStage[] = [
  'queued', 'snapshotting', 'agent', 'verifying', 'ready-to-publish', 'publishing', 'terminal',
];

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && ALL_STATUSES.some(status => status === value);
}

function isJobStage(value: unknown): value is JobStage {
  return typeof value === 'string' && ALL_STAGES.some(stage => stage === value);
}

export interface TargetJobEnvironment extends HostedProviderEnvironment {
  DB: D1DatabaseBinding;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  SANDBOX: SandboxNamespace;
}

type TargetJobContext = ConstructorParameters<typeof DurableObject<TargetJobEnvironment>>[0];
type JobStorage = OpenCodeWorkerd.CreateOptions['storage'];

export type DurableJobSqlPort = Pick<JobStorage, 'sql' | 'transactionSync'>;

export class TargetJobError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TargetJobError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPlan(value: unknown): value is PinnedPlan {
  if (!isRecord(value)) return false;
  const strings = [
    'trackingId', 'baseBranch', 'targetBaseCommit', 'upstreamRepository', 'upstreamRef', 'expectedLastCheckedCommit',
    'fromCommit', 'toCommit', 'observedAt', 'jobId', 'jobKey', 'policyHash',
  ];
  if (strings.some(key => typeof value[key] !== 'string')
    || !Number.isSafeInteger(value.installationId) || !Number.isSafeInteger(value.commitCount)
    || !Array.isArray(value.changedFiles) || value.changedFiles.some(change => !isRecord(change)
      || typeof change.path !== 'string' || (change.status !== 'added' && change.status !== 'modified' && change.status !== 'deleted'))
    || !isStringArray(value.changedPaths) || !isStringArray(value.checkedChangedPaths)
    || !isStringArray(value.selectedUpstreamPaths) || !isStringArray(value.checkedSelectedUpstreamPaths)
    || !isStringArray(value.selectedSelectionIds) || !isRecord(value.target)) return false;
  return typeof value.target.owner === 'string' && typeof value.target.name === 'string'
    && typeof value.target.fullName === 'string';
}

function isStoredProposal(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.report) || !Array.isArray(value.report.decisions)
    || typeof value.report.summary !== 'string' || !Array.isArray(value.edits)
    || !isRecord(value.checkpointCandidate)) return false;
  if (value.edits.some(edit => !isRecord(edit) || typeof edit.path !== 'string'
    || (edit.operation !== 'write' && edit.operation !== 'delete')
    || (edit.operation === 'write' && typeof edit.content !== 'string'))) return false;
  const candidate = value.checkpointCandidate;
  const candidateKeys = [
    'trackingId', 'jobId', 'jobKey', 'upstreamCommit', 'targetBaseCommit', 'policyHash',
    'expectedLastCheckedCommit', 'expectedLastSyncedCommit',
  ];
  if (candidateKeys.some(key => typeof candidate[key] !== 'string')) return false;
  if (value.verification !== undefined && (!isRecord(value.verification)
    || (value.verification.status !== 'passed' && value.verification.status !== 'failed')
    || !Array.isArray(value.verification.steps) || !Array.isArray(value.verification.workspaceFiles))) return false;
  return true;
}

function isJobRecord(value: unknown): value is JobRecord {
  if (!isRecord(value)) return false;
  const permitted = new Set([
    'id', 'key', 'trackingId', 'status', 'stage', 'version', 'attempt', 'stepsUsed', 'plan',
    'proposal', 'failure', 'createdAt', 'updatedAt',
  ]);
  if (Object.keys(value).some(key => !permitted.has(key))
    || typeof value.id !== 'string' || typeof value.key !== 'string' || typeof value.trackingId !== 'string'
    || !isJobStatus(value.status) || !isJobStage(value.stage)
    || !Number.isSafeInteger(value.version) || Number(value.version) < 0
    || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0
    || !Number.isSafeInteger(value.stepsUsed) || Number(value.stepsUsed) < 0
    || !isPlan(value.plan) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (value.proposal !== undefined && !isStoredProposal(value.proposal)) return false;
  if (value.failure !== undefined && (!isRecord(value.failure) || typeof value.failure.code !== 'string')) return false;
  return value.plan.jobId === value.id && value.plan.jobKey === value.key && value.trackingId === value.plan.trackingId;
}

function safeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > MAX_JOB_RECORD_BYTES) {
    throw new TargetJobError('job-record-limit');
  }
  return json;
}

function parseJobJson(value: unknown): JobRecord {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_JOB_RECORD_BYTES) {
    throw new TargetJobError('job-record-corrupt');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TargetJobError('job-record-corrupt');
  }
  if (!isJobRecord(parsed)) throw new TargetJobError('job-record-corrupt');
  return parsed;
}

function validPublication(value: DraftPublication): boolean {
  return Number.isSafeInteger(value.pullRequestNumber) && value.pullRequestNumber > 0
    && typeof value.url === 'string' && value.url.startsWith('https://github.com/') && value.url.length <= 2_048
    && typeof value.headCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.headCommit);
}

function sanitizedFailure(error: unknown): string {
  if (error instanceof CoreError || error instanceof TargetJobError) return error.code;
  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(error.code)) return error.code;
  return 'github-publication-failed';
}

function nowIso(): string {
  return new Date().toISOString();
}

async function boundedPromise<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TargetJobError(code)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PublicationEffect {
  jobId: string;
  attempts: number;
  status: 'publishing' | 'retryable' | 'published' | 'merged' | 'closed-unmerged' | 'failed' | 'uncertain';
  claimToken?: string;
  leaseUntil?: number;
  nextAttemptAt?: number;
  reconciliationAttempts: number;
  lastFailureCode?: string;
  pullRequestNumber?: number;
  url?: string;
  headCommit?: string;
  updatedAt: string;
}

type PublicationClaim =
  | { kind: 'claimed'; attempt: number; claimToken: string; leaseUntil: number }
  | { kind: 'deferred'; dueAt: number }
  | { kind: 'published'; effect: PublicationEffect }
  | { kind: 'operator-review' }
  | { kind: 'exhausted' };

interface DurableRunState {
  generationId: string;
  trackingId: string;
  jobId?: string;
  status: 'active' | 'completed' | 'cancelled' | 'expired' | 'failed';
  deadlineAt: number;
  cancelRequested: boolean;
  cancelCode?: string;
}

interface PublishedJobPage {
  jobs: JobRecord[];
  lastJobId?: string;
}

interface ExecutionOperation {
  kind: 'run' | 'reconcile' | 'alarm';
  trackingId?: string;
  generationId?: string;
  controller?: AbortController;
  deadlineAt?: number;
  promise: Promise<void>;
}

interface RunContext {
  controller: AbortController;
  deadlineAt: number;
  generationId: string;
  trackingId: string;
  startedAt: number;
}

interface OperationGuard {
  controller: AbortController;
  deadlineAt: number;
}

export class DurableSqliteJobStore implements DurableJobStorePort {
  constructor(private readonly storage: DurableJobSqlPort) {}

  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${JOB_TABLE} (
        id TEXT PRIMARY KEY,
        job_key TEXT NOT NULL UNIQUE,
        tracking_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        source_from_commit TEXT,
        source_to_commit TEXT,
        target_base_commit TEXT,
        policy_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS ocpa_job_status_updated_idx ON ${JOB_TABLE}(status, updated_at);
      CREATE INDEX IF NOT EXISTS ocpa_job_tracking_status_idx ON ${JOB_TABLE}(tracking_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS ${EFFECT_TABLE} (
        job_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        status TEXT NOT NULL,
        claim_token TEXT,
        lease_until INTEGER,
        next_attempt_at INTEGER,
        reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
        last_failure_code TEXT,
        pull_request_number INTEGER,
        url TEXT,
        head_commit TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${IDENTITY_TABLE} (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        identity_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${CLEANUP_TABLE} (
        job_id TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${SESSION_CLEANUP_TABLE} (
        session_id TEXT PRIMARY KEY,
        job_id TEXT,
        requested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ocpa_job_sessions (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        generation_id TEXT NOT NULL,
        tracking_id TEXT NOT NULL,
        job_id TEXT,
        status TEXT NOT NULL,
        deadline_at INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_code TEXT
      );
      CREATE TABLE IF NOT EXISTS ${RECONCILE_CURSOR_TABLE} (
        tracking_id TEXT PRIMARY KEY,
        after_job_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${RECONCILE_SWEEP_TABLE} (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        after_tracking_id TEXT
      );
      CREATE TABLE IF NOT EXISTS ${WORK_CURSOR_TABLE} (
        name TEXT PRIMARY KEY,
        cursor TEXT NOT NULL
      );
    `);
    this.ensureJobIdentityColumns();
    this.ensurePublicationColumns();
    this.ensureSessionCleanupColumns();
  }

  private ensureJobIdentityColumns(): void {
    const rows = this.storage.sql.exec(`PRAGMA table_info(${JOB_TABLE})`).toArray();
    const names = new Set<string>(rows.map((row: Record<string, unknown>) => row.name)
      .filter((name: unknown): name is string => typeof name === 'string'));
    const additions: ReadonlyArray<readonly [string, string]> = [
      ['source_from_commit', 'TEXT'],
      ['source_to_commit', 'TEXT'],
      ['target_base_commit', 'TEXT'],
      ['policy_hash', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!names.has(name)) this.storage.sql.exec(`ALTER TABLE ${JOB_TABLE} ADD COLUMN ${name} ${type}`);
    }
    this.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ocpa_job_source_range_idx
      ON ${JOB_TABLE}(tracking_id, source_from_commit, source_to_commit, policy_hash, target_base_commit)`);
    this.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ocpa_job_sync_origin_idx
      ON ${JOB_TABLE}(tracking_id, source_from_commit, policy_hash, updated_at DESC, id)`);
  }

  private ensurePublicationColumns(): void {
    const rows = this.storage.sql.exec(`PRAGMA table_info(${EFFECT_TABLE})`).toArray();
    const names = new Set<string>(rows.map((row: Record<string, unknown>) => row.name)
      .filter((name: unknown): name is string => typeof name === 'string'));
    const additions: ReadonlyArray<readonly [string, string]> = [
      ['claim_token', 'TEXT'],
      ['lease_until', 'INTEGER'],
      ['next_attempt_at', 'INTEGER'],
      ['reconciliation_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of additions) {
      if (!names.has(name)) this.storage.sql.exec(`ALTER TABLE ${EFFECT_TABLE} ADD COLUMN ${name} ${type}`);
    }
    this.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ocpa_publication_due_idx ON ${EFFECT_TABLE}(status, next_attempt_at, lease_until)`);
  }

  private ensureSessionCleanupColumns(): void {
    const rows = this.storage.sql.exec(`PRAGMA table_info(${SESSION_CLEANUP_TABLE})`).toArray();
    const names = new Set<string>(rows.map((row: Record<string, unknown>) => row.name)
      .filter((name: unknown): name is string => typeof name === 'string'));
    if (!names.has('job_id')) this.storage.sql.exec(`ALTER TABLE ${SESSION_CLEANUP_TABLE} ADD COLUMN job_id TEXT`);
  }

  bindTargetIdentity(identityHash: string): void {
    const row = this.storage.sql.exec(`SELECT identity_hash FROM ${IDENTITY_TABLE} WHERE id = 1`).toArray()[0];
    if (!row) {
      this.storage.sql.exec(`INSERT INTO ${IDENTITY_TABLE}(id, identity_hash) VALUES(1, ?)`, identityHash);
      return;
    }
    if (row.identity_hash !== identityHash) throw new TargetJobError('durable-object-target-mismatch');
  }

  setRunJobId(generationId: string, jobId: string): boolean {
    return this.storage.sql.exec(
      `UPDATE ${RUN_TABLE} SET job_id = ? WHERE id = 1 AND generation_id = ? AND status = 'active' AND cancel_requested = 0 RETURNING id`,
      jobId, generationId,
    ).toArray().length === 1;
  }

  createOrGetJobForRun(generationId: string, input: NewJobRecord): { job: JobRecord; created: boolean } {
    return this.storage.transactionSync(() => {
      const run = this.runState();
      if (!run || run.generationId !== generationId || run.status !== 'active'
        || run.cancelRequested || run.deadlineAt <= Date.now()) throw new TargetJobError('job-run-cancelled');
      const existingRow = this.storage.sql.exec(
        `SELECT record_json FROM ${JOB_TABLE} WHERE id = ? LIMIT 1`, input.id,
      ).toArray()[0];
      let job: JobRecord;
      let created = false;
      if (existingRow) {
        job = parseJobJson(existingRow.record_json);
        if (job.key !== input.key || job.trackingId !== input.trackingId) throw new TargetJobError('job-key-conflict');
      } else {
        const keyRow = this.storage.sql.exec(
          `SELECT record_json FROM ${JOB_TABLE} WHERE job_key = ? LIMIT 1`, input.key,
        ).toArray()[0];
        if (keyRow) throw new TargetJobError('job-key-conflict');
        const timestamp = nowIso();
        job = {
          ...input,
          status: 'queued',
          stage: 'queued',
          version: 0,
          attempt: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.storage.sql.exec(
          `INSERT INTO ${JOB_TABLE}(
             id, job_key, tracking_id, status, stage, version, updated_at, record_json,
             source_from_commit, source_to_commit, target_base_commit, policy_hash
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          job.id, job.key, job.trackingId, job.status, job.stage, job.version, job.updatedAt, safeJson(job),
          job.plan.fromCommit, job.plan.toCommit, job.plan.targetBaseCommit, job.plan.policyHash,
        );
        created = true;
      }
      const admitted = this.storage.sql.exec(
        `UPDATE ${RUN_TABLE} SET job_id = ? WHERE id = 1 AND generation_id = ? AND status = 'active'
         AND cancel_requested = 0 AND deadline_at > ? RETURNING id`,
        job.id, generationId, Date.now(),
      ).toArray();
      if (admitted.length !== 1) throw new TargetJobError('job-run-cancelled');
      return { job, created };
    });
  }

  markJobTerminalWithCleanup(job: JobRecord, status: 'failed' | 'cancelled', code: string, sessionID?: string): JobRecord {
    const updated: JobRecord = {
      ...job,
      status,
      stage: 'terminal',
      failure: { code: code.slice(0, 64) },
      version: job.version + 1,
      updatedAt: nowIso(),
    };
    return this.terminalizeJobWithCleanup(updated, job.version, sessionID);
  }

  async createOrGetJob(input: NewJobRecord): Promise<{ job: JobRecord; created: boolean }> {
    const existing = await this.getJob(input.id);
    if (existing) {
      if (existing.key !== input.key || existing.trackingId !== input.trackingId) throw new TargetJobError('job-key-conflict');
      return { job: existing, created: false };
    }
    if (await this.getJobByKey(input.key)) throw new TargetJobError('job-key-conflict');
    const timestamp = nowIso();
    const job: JobRecord = {
      ...input,
      status: 'queued',
      stage: 'queued',
      version: 0,
      attempt: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.storage.sql.exec(
        `INSERT INTO ${JOB_TABLE}(
           id, job_key, tracking_id, status, stage, version, updated_at, record_json,
           source_from_commit, source_to_commit, target_base_commit, policy_hash
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        job.id, job.key, job.trackingId, job.status, job.stage, job.version, job.updatedAt, safeJson(job),
        job.plan.fromCommit, job.plan.toCommit, job.plan.targetBaseCommit, job.plan.policyHash,
      );
    } catch {
      const duplicate = await this.getJob(input.id) ?? await this.getJobByKey(input.key);
      if (duplicate && duplicate.id === input.id && duplicate.key === input.key) return { job: duplicate, created: false };
      throw new TargetJobError('job-persist-conflict');
    }
    return { job, created: true };
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    return this.readJob('SELECT record_json FROM ' + JOB_TABLE + ' WHERE id = ? LIMIT 1', id);
  }

  async getJobByKey(jobKey: string): Promise<JobRecord | undefined> {
    return this.readJob('SELECT record_json FROM ' + JOB_TABLE + ' WHERE job_key = ? LIMIT 1', jobKey);
  }

  async listJobsForCumulativeRange(input: CumulativeRangeQuery): Promise<CumulativeRangeJobs> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.trackingId)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.fromCommit)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.toCommit)
      || !/^[a-f0-9]{64}$/i.test(input.policyHash)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 4) {
      throw new TargetJobError('cumulative-range-query-invalid');
    }
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${JOB_TABLE}
       WHERE tracking_id = ? AND source_from_commit = ? AND source_to_commit = ? AND policy_hash = ?
       ORDER BY updated_at DESC, id LIMIT ?`,
      input.trackingId, input.fromCommit, input.toCommit, input.policyHash, input.limit + 1,
    ).toArray();
    return {
      jobs: rows.slice(0, input.limit).map((row: Record<string, unknown>) => parseJobJson(row.record_json)),
      more: rows.length > input.limit,
    };
  }

  async listJobsForSyncOrigin(input: SyncOriginQuery): Promise<CumulativeRangeJobs> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.trackingId)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.fromCommit)
      || !/^[a-f0-9]{64}$/i.test(input.policyHash)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) {
      throw new TargetJobError('sync-origin-query-invalid');
    }
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${JOB_TABLE}
       WHERE tracking_id = ? AND source_from_commit = ? AND policy_hash = ?
       ORDER BY updated_at DESC, id LIMIT ?`,
      input.trackingId, input.fromCommit, input.policyHash, input.limit + 1,
    ).toArray();
    return {
      jobs: rows.slice(0, input.limit).map((row: Record<string, unknown>) => parseJobJson(row.record_json)),
      more: rows.length > input.limit,
    };
  }

  async saveJob(record: JobRecord, expectedVersion: number): Promise<JobRecord> {
    if (!isJobRecord(record) || record.version !== expectedVersion + 1) throw new TargetJobError('job-version-invalid');
    const changed = this.storage.sql.exec(
      `UPDATE ${JOB_TABLE}
       SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?,
         source_from_commit = ?, source_to_commit = ?, target_base_commit = ?, policy_hash = ?
       WHERE id = ? AND version = ? RETURNING id`,
      record.key, record.trackingId, record.status, record.stage, record.version, record.updatedAt,
      safeJson(record), record.plan.fromCommit, record.plan.toCommit, record.plan.targetBaseCommit, record.plan.policyHash,
      record.id, expectedVersion,
    ).toArray();
    if (changed.length !== 1) throw new TargetJobError('job-version-conflict');
    return record;
  }

  listByStatuses(statuses: readonly JobStatus[], limit = 33): JobRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${JOB_TABLE} WHERE status IN (${placeholders}) ORDER BY updated_at ASC LIMIT ?`,
      ...statuses,
      limit,
    ).toArray();
    return rows.map((row: Record<string, unknown>) => parseJobJson(row.record_json));
  }

  listByStatusesPage(name: string, statuses: readonly JobStatus[], limit: number): { jobs: JobRecord[]; more: boolean } {
    if (statuses.length === 0) return { jobs: [], more: false };
    const after = this.workCursor(name);
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = after
      ? this.storage.sql.exec(
        `SELECT record_json FROM ${JOB_TABLE} WHERE status IN (${placeholders}) AND id > ? ORDER BY id LIMIT ?`,
        ...statuses, after, limit,
      ).toArray()
      : this.storage.sql.exec(
        `SELECT record_json FROM ${JOB_TABLE} WHERE status IN (${placeholders}) ORDER BY id LIMIT ?`,
        ...statuses, limit,
      ).toArray();
    const jobs = rows.map((row: Record<string, unknown>) => parseJobJson(row.record_json));
    if (jobs.length === 0) {
      this.clearWorkCursor(name);
      return { jobs, more: false };
    }
    if (jobs.length === limit) this.setWorkCursor(name, jobs[jobs.length - 1]!.id);
    else this.clearWorkCursor(name);
    return { jobs, more: jobs.length === limit };
  }

  private workCursor(name: string): string | undefined {
    const row = this.storage.sql.exec(`SELECT cursor FROM ${WORK_CURSOR_TABLE} WHERE name = ?`, name).toArray()[0];
    if (!row) return undefined;
    if (typeof row.cursor !== 'string') throw new TargetJobError('work-cursor-corrupt');
    return row.cursor;
  }

  private setWorkCursor(name: string, cursor: string): void {
    this.storage.sql.exec(
      `INSERT INTO ${WORK_CURSOR_TABLE}(name, cursor) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`,
      name, cursor,
    );
  }

  private clearWorkCursor(name: string): void {
    this.storage.sql.exec(`DELETE FROM ${WORK_CURSOR_TABLE} WHERE name = ?`, name);
  }

  listByTrackingStatuses(trackingId: string, statuses: readonly JobStatus[], limit = 33): JobRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.storage.sql.exec(
      `SELECT record_json FROM ${JOB_TABLE} WHERE tracking_id = ? AND status IN (${placeholders}) ORDER BY id LIMIT ?`,
      trackingId, ...statuses, limit,
    ).toArray();
    return rows.map((row: Record<string, unknown>) => parseJobJson(row.record_json));
  }

  listByTrackingStatusesPage(
    trackingId: string,
    name: string,
    statuses: readonly JobStatus[],
    limit: number,
  ): { jobs: JobRecord[]; more: boolean } {
    if (statuses.length === 0) return { jobs: [], more: false };
    const after = this.workCursor(name);
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = after
      ? this.storage.sql.exec(
        `SELECT record_json FROM ${JOB_TABLE} WHERE tracking_id = ? AND status IN (${placeholders}) AND id > ? ORDER BY id LIMIT ?`,
        trackingId, ...statuses, after, limit,
      ).toArray()
      : this.storage.sql.exec(
        `SELECT record_json FROM ${JOB_TABLE} WHERE tracking_id = ? AND status IN (${placeholders}) ORDER BY id LIMIT ?`,
        trackingId, ...statuses, limit,
      ).toArray();
    const jobs = rows.map((row: Record<string, unknown>) => parseJobJson(row.record_json));
    if (jobs.length === 0) {
      this.clearWorkCursor(name);
      return { jobs, more: false };
    }
    if (jobs.length === limit) this.setWorkCursor(name, jobs[jobs.length - 1]!.id);
    else this.clearWorkCursor(name);
    return { jobs, more: jobs.length === limit };
  }

  listPublishedForTrackingPage(trackingId: string, afterJobId: string | undefined, limit: number): PublishedJobPage {
    const rows = afterJobId
      ? this.storage.sql.exec(
        `SELECT j.record_json FROM ${JOB_TABLE} j JOIN ${EFFECT_TABLE} e ON e.job_id = j.id
         WHERE j.tracking_id = ? AND j.status = 'published' AND e.status = 'published'
           AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?) AND j.id > ? ORDER BY j.id LIMIT ?`,
        trackingId, Date.now(), afterJobId, limit,
      ).toArray()
      : this.storage.sql.exec(
        `SELECT j.record_json FROM ${JOB_TABLE} j JOIN ${EFFECT_TABLE} e ON e.job_id = j.id
         WHERE j.tracking_id = ? AND j.status = 'published' AND e.status = 'published'
           AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?) ORDER BY j.id LIMIT ?`,
        trackingId, Date.now(), limit,
      ).toArray();
    const jobs = rows.map((row: Record<string, unknown>) => parseJobJson(row.record_json));
    return { jobs, ...(jobs.length > 0 ? { lastJobId: jobs[jobs.length - 1]!.id } : {}) };
  }

  hasPublishedLifecycleJobs(trackingId: string): boolean {
    return this.storage.sql.exec(
      `SELECT j.id FROM ${JOB_TABLE} j JOIN ${EFFECT_TABLE} e ON e.job_id = j.id
       WHERE j.tracking_id = ? AND j.status = 'published' AND e.status = 'published' LIMIT 1`,
      trackingId,
    ).toArray().length > 0;
  }

  listPublishedTrackingIds(afterTrackingId: string | undefined, limit: number, now = Date.now()): { trackingIds: string[]; more: boolean } {
    const rows = afterTrackingId
      ? this.storage.sql.exec(
        `SELECT DISTINCT j.tracking_id FROM ${JOB_TABLE} j JOIN ${EFFECT_TABLE} e ON e.job_id = j.id
         WHERE j.status = 'published' AND e.status = 'published' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)
           AND j.tracking_id > ? ORDER BY j.tracking_id LIMIT ?`,
        now, afterTrackingId, limit + 1,
      ).toArray()
      : this.storage.sql.exec(
        `SELECT DISTINCT j.tracking_id FROM ${JOB_TABLE} j JOIN ${EFFECT_TABLE} e ON e.job_id = j.id
         WHERE j.status = 'published' AND e.status = 'published' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)
         ORDER BY j.tracking_id LIMIT ?`,
        now, limit + 1,
      ).toArray();
    const trackingIds = rows.slice(0, limit).map((row: Record<string, unknown>) => {
      if (typeof row.tracking_id !== 'string') throw new TargetJobError('reconcile-sweep-corrupt');
      return row.tracking_id;
    });
    return { trackingIds, more: rows.length > limit };
  }

  reconciliationCursor(trackingId: string): string | undefined {
    const row = this.storage.sql.exec(`SELECT after_job_id FROM ${RECONCILE_CURSOR_TABLE} WHERE tracking_id = ?`, trackingId).toArray()[0];
    if (!row) return undefined;
    if (typeof row.after_job_id !== 'string') throw new TargetJobError('reconcile-cursor-corrupt');
    return row.after_job_id;
  }

  setReconciliationCursor(trackingId: string, afterJobId: string): void {
    this.storage.sql.exec(
      `INSERT INTO ${RECONCILE_CURSOR_TABLE}(tracking_id, after_job_id) VALUES(?, ?)
       ON CONFLICT(tracking_id) DO UPDATE SET after_job_id = excluded.after_job_id`,
      trackingId,
      afterJobId,
    );
  }

  clearReconciliationCursor(trackingId: string): void {
    this.storage.sql.exec(`DELETE FROM ${RECONCILE_CURSOR_TABLE} WHERE tracking_id = ?`, trackingId);
  }

  listReconciliationCursorTrackingIds(afterTrackingId: string | undefined, limit: number): string[] {
    const rows = afterTrackingId
      ? this.storage.sql.exec(
        `SELECT tracking_id FROM ${RECONCILE_CURSOR_TABLE} WHERE tracking_id > ? ORDER BY tracking_id LIMIT ?`,
        afterTrackingId, limit,
      ).toArray()
      : this.storage.sql.exec(
        `SELECT tracking_id FROM ${RECONCILE_CURSOR_TABLE} ORDER BY tracking_id LIMIT ?`,
        limit,
      ).toArray();
    return rows.map((row: Record<string, unknown>) => {
      if (typeof row.tracking_id !== 'string') throw new TargetJobError('reconcile-cursor-corrupt');
      return row.tracking_id;
    });
  }

  hasReconciliationCursors(): boolean {
    return this.storage.sql.exec(`SELECT tracking_id FROM ${RECONCILE_CURSOR_TABLE} LIMIT 1`).toArray().length > 0;
  }

  reconciliationSweepCursor(): string | undefined {
    const row = this.storage.sql.exec(`SELECT after_tracking_id FROM ${RECONCILE_SWEEP_TABLE} WHERE id = 1`).toArray()[0];
    if (!row) return undefined;
    if (typeof row.after_tracking_id !== 'string') return undefined;
    return row.after_tracking_id;
  }

  setReconciliationSweepCursor(afterTrackingId: string | undefined): void {
    this.storage.sql.exec(
      `INSERT INTO ${RECONCILE_SWEEP_TABLE}(id, after_tracking_id) VALUES(1, ?)
       ON CONFLICT(id) DO UPDATE SET after_tracking_id = excluded.after_tracking_id`,
      afterTrackingId ?? null,
    );
  }

  requestSandboxCleanup(jobId: string): void {
    this.storage.sql.exec(
      `INSERT INTO ${CLEANUP_TABLE}(job_id, requested_at) VALUES(?, ?) ON CONFLICT(job_id) DO NOTHING`,
      jobId,
      nowIso(),
    );
  }

  pendingSandboxCleanup(limit = 33): string[] {
    const rows = this.storage.sql.exec(`SELECT job_id FROM ${CLEANUP_TABLE} ORDER BY requested_at ASC LIMIT ?`, limit).toArray();
    return rows.map((row: Record<string, unknown>) => {
      if (typeof row.job_id !== 'string') throw new TargetJobError('cleanup-request-corrupt');
      return row.job_id;
    });
  }

  completeSandboxCleanup(jobId: string): void {
    this.storage.sql.exec(`DELETE FROM ${CLEANUP_TABLE} WHERE job_id = ?`, jobId);
  }

  persistSessionStarted(jobId: string, sessionID: string): void {
    this.storage.sql.exec(
      `INSERT INTO ocpa_job_sessions(job_id, session_id, created_at) VALUES(?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at`,
      jobId, sessionID, nowIso(),
    );
  }

  sessionForJob(jobId: string): string | undefined {
    const row = this.storage.sql.exec(`SELECT session_id FROM ocpa_job_sessions WHERE job_id = ? LIMIT 1`, jobId).toArray()[0];
    if (!row) return undefined;
    if (typeof row.session_id !== 'string') throw new TargetJobError('job-session-map-corrupt');
    return row.session_id;
  }

  requestSessionCleanup(jobId: string | undefined, sessionID: string): void {
    this.storage.sql.exec(
      `INSERT INTO ${SESSION_CLEANUP_TABLE}(session_id, job_id, requested_at) VALUES(?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET job_id = COALESCE(excluded.job_id, ${SESSION_CLEANUP_TABLE}.job_id)`,
      sessionID, jobId ?? null, nowIso(),
    );
  }

  pendingSessionCleanup(limit = 33): Array<{ sessionID: string; jobId?: string }> {
    const rows = this.storage.sql.exec(`SELECT session_id, job_id FROM ${SESSION_CLEANUP_TABLE} ORDER BY requested_at LIMIT ?`, limit).toArray();
    return rows.map((row: Record<string, unknown>) => {
      if (typeof row.session_id !== 'string') throw new TargetJobError('session-cleanup-request-corrupt');
      return {
        sessionID: row.session_id,
        ...(typeof row.job_id === 'string' ? { jobId: row.job_id } : {}),
      };
    });
  }

  completeSessionCleanup(sessionID: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM ${SESSION_CLEANUP_TABLE} WHERE session_id = ?`, sessionID);
      this.storage.sql.exec(`DELETE FROM ocpa_job_sessions WHERE session_id = ?`, sessionID);
    });
  }

  requestRunCancellation(trackingId: string, code: string): DurableRunState | undefined {
    return this.storage.transactionSync(() => {
      const current = this.runState();
      if (!current || current.status !== 'active' || current.trackingId !== trackingId) return undefined;
      this.storage.sql.exec(
        `UPDATE ${RUN_TABLE} SET cancel_requested = 1, cancel_code = ? WHERE id = 1 AND generation_id = ? AND status = 'active'`,
        code.slice(0, 64), current.generationId,
      );
      return { ...current, cancelRequested: true, cancelCode: code.slice(0, 64) };
    });
  }

  cancelRunGeneration(generationId: string, code: string): boolean {
    return this.storage.sql.exec(
      `UPDATE ${RUN_TABLE} SET cancel_requested = 1, cancel_code = ?
       WHERE id = 1 AND generation_id = ? AND status = 'active' RETURNING id`,
      code.slice(0, 64), generationId,
    ).toArray().length === 1;
  }

  beginRun(generationId: string, trackingId: string, deadlineAt: number): void {
    this.storage.transactionSync(() => {
      const current = this.runState();
      if (current?.status === 'active') throw new TargetJobError('target-job-busy');
      this.storage.sql.exec(
        `INSERT INTO ${RUN_TABLE}(id, generation_id, tracking_id, job_id, status, deadline_at, cancel_requested, cancel_code)
         VALUES(1, ?, ?, NULL, 'active', ?, 0, NULL)
         ON CONFLICT(id) DO UPDATE SET generation_id = excluded.generation_id, tracking_id = excluded.tracking_id,
           job_id = NULL, status = 'active', deadline_at = excluded.deadline_at, cancel_requested = 0, cancel_code = NULL`,
        generationId, trackingId, deadlineAt,
      );
    });
  }

  updateRunDeadline(generationId: string, deadlineAt: number): boolean {
    return this.storage.sql.exec(
      `UPDATE ${RUN_TABLE} SET deadline_at = ? WHERE id = 1 AND generation_id = ? AND status = 'active' AND cancel_requested = 0 RETURNING id`,
      deadlineAt, generationId,
    ).toArray().length === 1;
  }

  runState(): DurableRunState | undefined {
    const row = this.storage.sql.exec(
      `SELECT generation_id, tracking_id, job_id, status, deadline_at, cancel_requested, cancel_code FROM ${RUN_TABLE} WHERE id = 1`,
    ).toArray()[0];
    if (!row) return undefined;
    const status = row.status;
    if (typeof row.generation_id !== 'string' || typeof row.tracking_id !== 'string'
      || (status !== 'active' && status !== 'completed' && status !== 'cancelled' && status !== 'expired' && status !== 'failed')
      || typeof row.deadline_at !== 'number' || !Number.isSafeInteger(row.deadline_at)
      || (row.cancel_requested !== 0 && row.cancel_requested !== 1)) throw new TargetJobError('run-state-corrupt');
    if (row.job_id !== null && typeof row.job_id !== 'string') throw new TargetJobError('run-state-corrupt');
    return {
      generationId: row.generation_id,
      trackingId: row.tracking_id,
      ...(typeof row.job_id === 'string' ? { jobId: row.job_id } : {}),
      status,
      deadlineAt: row.deadline_at,
      cancelRequested: row.cancel_requested === 1,
      ...(typeof row.cancel_code === 'string' ? { cancelCode: row.cancel_code } : {}),
    };
  }

  finishRun(generationId: string, status: Exclude<DurableRunState['status'], 'active'>, code?: string): boolean {
    const result = status === 'completed'
      ? this.storage.sql.exec(
        `UPDATE ${RUN_TABLE} SET status = 'completed' WHERE id = 1 AND generation_id = ?
         AND status = 'active' AND cancel_requested = 0 AND deadline_at > ? RETURNING id`,
        generationId, Date.now(),
      )
      : this.storage.sql.exec(
        `UPDATE ${RUN_TABLE} SET status = ?, cancel_requested = CASE WHEN ? IS NULL THEN cancel_requested ELSE 1 END,
         cancel_code = COALESCE(?, cancel_code) WHERE id = 1 AND generation_id = ? AND status = 'active' RETURNING id`,
        status, code ?? null, code ?? null, generationId,
      );
    return result.toArray().length === 1;
  }

  terminalizeJobWithCleanup(job: JobRecord, expectedVersion: number, sessionID?: string): JobRecord {
    if (!isJobRecord(job) || job.version !== expectedVersion + 1) throw new TargetJobError('job-version-invalid');
    this.storage.transactionSync(() => {
      const updated = this.storage.sql.exec(
        `UPDATE ${JOB_TABLE} SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?
         WHERE id = ? AND version = ? RETURNING id`,
        job.key, job.trackingId, job.status, job.stage, job.version, job.updatedAt,
        safeJson(job), job.id, expectedVersion,
      ).toArray();
      if (updated.length !== 1) throw new TargetJobError('job-version-conflict');
      this.storage.sql.exec(
        `INSERT INTO ${CLEANUP_TABLE}(job_id, requested_at) VALUES(?, ?) ON CONFLICT(job_id) DO NOTHING`,
        job.id, nowIso(),
      );
      if (sessionID) {
        this.storage.sql.exec(
          `INSERT INTO ${SESSION_CLEANUP_TABLE}(session_id, job_id, requested_at) VALUES(?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET job_id = excluded.job_id`,
          sessionID, job.id, nowIso(),
        );
      }
    });
    return job;
  }

  claimPublication(jobId: string, now: number, leaseMs: number): PublicationClaim {
    return this.storage.transactionSync(() => {
      const current = this.publicationEffect(jobId);
      if (current?.status === 'published') return { kind: 'published', effect: current };
      if (current?.status === 'uncertain') return { kind: 'operator-review' };
      if (current?.status === 'failed' || (current?.attempts ?? 0) >= MAX_PUBLICATION_ATTEMPTS) return { kind: 'exhausted' };
      const dueAt = current?.status === 'publishing'
        ? current.leaseUntil ?? now
        : current?.nextAttemptAt ?? now;
      if (dueAt > now) return { kind: 'deferred', dueAt };
      const attempt = (current?.attempts ?? 0) + 1;
      const claimToken = crypto.randomUUID();
      const leaseUntil = now + leaseMs;
      this.storage.sql.exec(
        `INSERT INTO ${EFFECT_TABLE}(job_id, attempts, status, claim_token, lease_until, next_attempt_at, updated_at)
         VALUES(?, ?, 'publishing', ?, ?, NULL, ?)
         ON CONFLICT(job_id) DO UPDATE SET attempts = excluded.attempts, status = 'publishing',
           claim_token = excluded.claim_token, lease_until = excluded.lease_until, next_attempt_at = NULL,
           last_failure_code = NULL, updated_at = excluded.updated_at`,
        jobId, attempt, claimToken, leaseUntil, nowIso(),
      );
      return { kind: 'claimed', attempt, claimToken, leaseUntil };
    });
  }

  markPublicationRetryable(jobId: string, claimToken: string, code: string, nextAttemptAt: number): boolean {
    return this.storage.sql.exec(
      `UPDATE ${EFFECT_TABLE} SET status = 'retryable', last_failure_code = ?, claim_token = NULL,
       lease_until = NULL, next_attempt_at = ?, updated_at = ?
       WHERE job_id = ? AND claim_token = ? AND status = 'publishing' RETURNING job_id`,
      code.slice(0, 64), nextAttemptAt, nowIso(), jobId, claimToken,
    ).toArray().length === 1;
  }

  markPublicationFailed(jobId: string, code: string): void {
    this.storage.sql.exec(
      `UPDATE ${EFFECT_TABLE} SET status = 'failed', last_failure_code = ?, claim_token = NULL,
       lease_until = NULL, next_attempt_at = NULL, updated_at = ? WHERE job_id = ?`,
      code.slice(0, 64), nowIso(), jobId,
    );
  }

  markPublicationUncertain(jobId: string, claimToken: string | undefined, code: string): void {
    this.storage.sql.exec(
      `UPDATE ${EFFECT_TABLE} SET status = 'uncertain', last_failure_code = ?, claim_token = NULL,
       lease_until = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE job_id = ? AND (? IS NULL OR claim_token = ?)`,
      code.slice(0, 64), nowIso(), jobId, claimToken ?? null, claimToken ?? null,
    );
  }

  markPublicationComplete(jobId: string, claimToken: string, publication: DraftPublication): boolean {
    return this.storage.sql.exec(
      `UPDATE ${EFFECT_TABLE}
       SET status = 'published', pull_request_number = ?, url = ?, head_commit = ?, last_failure_code = NULL,
       claim_token = NULL, lease_until = NULL, next_attempt_at = ?, reconciliation_attempts = 0, updated_at = ?
       WHERE job_id = ? AND claim_token = ? AND status = 'publishing' RETURNING job_id`,
      publication.pullRequestNumber, publication.url, publication.headCommit, Date.now(), nowIso(), jobId, claimToken,
    ).toArray().length === 1;
  }

  completePublication(job: JobRecord, claimToken: string, publication: DraftPublication): JobRecord {
    const published = withJobUpdate(job, { status: 'published', stage: 'terminal' });
    this.storage.transactionSync(() => {
      const effect = this.storage.sql.exec(
        `UPDATE ${EFFECT_TABLE}
         SET status = 'published', pull_request_number = ?, url = ?, head_commit = ?, last_failure_code = NULL,
         claim_token = NULL, lease_until = NULL, next_attempt_at = ?, reconciliation_attempts = 0, updated_at = ?
         WHERE job_id = ? AND claim_token = ? AND status = 'publishing' RETURNING job_id`,
        publication.pullRequestNumber, publication.url, publication.headCommit, Date.now(), nowIso(), job.id, claimToken,
      ).toArray();
      if (effect.length !== 1) throw new TargetJobError('publication-claim-lost');
      const record = this.storage.sql.exec(
        `UPDATE ${JOB_TABLE} SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?
         WHERE id = ? AND version = ? RETURNING id`,
        published.key, published.trackingId, published.status, published.stage, published.version,
        published.updatedAt, safeJson(published), published.id, job.version,
      ).toArray();
      if (record.length !== 1) throw new TargetJobError('job-version-conflict');
    });
    return published;
  }

  scheduleLifecycleRecheck(jobId: string, now: number, retryAfterSeconds?: number): number {
    const effect = this.publicationEffect(jobId);
    if (!effect || effect.status !== 'published' || !Number.isSafeInteger(now)) {
      throw new TargetJobError('lifecycle-recheck-state-invalid');
    }
    const exponential = Math.min(RETRY_MAX_MS, LIFECYCLE_RECHECK_MIN_MS * 2 ** Math.min(effect.reconciliationAttempts, 4));
    const requested = typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.min(6 * 60 * 60_000, retryAfterSeconds * 1_000)
      : 0;
    const dueAt = now + Math.max(exponential, requested);
    const changed = this.storage.sql.exec(
      `UPDATE ${EFFECT_TABLE} SET reconciliation_attempts = reconciliation_attempts + 1,
       next_attempt_at = ?, updated_at = ? WHERE job_id = ? AND status = 'published' RETURNING job_id`,
      dueAt, nowIso(), jobId,
    ).toArray();
    if (changed.length !== 1) throw new TargetJobError('lifecycle-recheck-state-conflict');
    return dueAt;
  }

  markClosedUnmerged(job: JobRecord, pullRequestNumber: number): JobRecord {
    if (job.status !== 'published' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
      throw new TargetJobError('closed-unmerged-transition-invalid');
    }
    const cancelled = withJobUpdate(job, {
      status: 'cancelled',
      stage: 'terminal',
      failure: { code: 'pull-request-closed-unmerged' },
    });
    this.storage.transactionSync(() => {
      const effect = this.storage.sql.exec(
        `UPDATE ${EFFECT_TABLE} SET status = 'closed-unmerged', last_failure_code = ?,
         claim_token = NULL, lease_until = NULL, next_attempt_at = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'published' AND pull_request_number = ? RETURNING job_id`,
        'pull-request-closed-unmerged', nowIso(), job.id, pullRequestNumber,
      ).toArray();
      if (effect.length !== 1) throw new TargetJobError('closed-unmerged-effect-conflict');
      const record = this.storage.sql.exec(
        `UPDATE ${JOB_TABLE} SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?
         WHERE id = ? AND version = ? RETURNING id`,
        cancelled.key, cancelled.trackingId, cancelled.status, cancelled.stage, cancelled.version,
        cancelled.updatedAt, safeJson(cancelled), cancelled.id, job.version,
      ).toArray();
      if (record.length !== 1) throw new TargetJobError('job-version-conflict');
    });
    return cancelled;
  }

  markPublicationMerged(job: JobRecord, pullRequestNumber: number): JobRecord {
    if (job.status !== 'published' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
      throw new TargetJobError('merged-publication-transition-invalid');
    }
    const merged = withJobUpdate(job, { status: 'merged', stage: 'terminal' });
    this.storage.transactionSync(() => {
      const effect = this.storage.sql.exec(
        `UPDATE ${EFFECT_TABLE} SET status = 'merged', next_attempt_at = NULL,
         claim_token = NULL, lease_until = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'published' AND pull_request_number = ? RETURNING job_id`,
        nowIso(), job.id, pullRequestNumber,
      ).toArray();
      if (effect.length !== 1) throw new TargetJobError('merged-publication-effect-conflict');
      const record = this.storage.sql.exec(
        `UPDATE ${JOB_TABLE} SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?
         WHERE id = ? AND version = ? RETURNING id`,
        merged.key, merged.trackingId, merged.status, merged.stage, merged.version,
        merged.updatedAt, safeJson(merged), merged.id, job.version,
      ).toArray();
      if (record.length !== 1) throw new TargetJobError('job-version-conflict');
    });
    return merged;
  }

  repairPublishedJob(job: JobRecord, publication: DraftPublication): JobRecord {
    const published = withJobUpdate(job, { status: 'published', stage: 'terminal' });
    this.storage.transactionSync(() => {
      const effect = this.publicationEffect(job.id);
      if (!effect || effect.status !== 'published' || effect.pullRequestNumber !== publication.pullRequestNumber
        || effect.url !== publication.url || effect.headCommit !== publication.headCommit) {
        throw new TargetJobError('publication-effect-mismatch');
      }
      const record = this.storage.sql.exec(
        `UPDATE ${JOB_TABLE} SET job_key = ?, tracking_id = ?, status = ?, stage = ?, version = ?, updated_at = ?, record_json = ?
         WHERE id = ? AND version = ? RETURNING id`,
        published.key, published.trackingId, published.status, published.stage, published.version,
        published.updatedAt, safeJson(published), published.id, job.version,
      ).toArray();
      if (record.length !== 1) throw new TargetJobError('job-version-conflict');
    });
    return published;
  }

  earliestPublicationWakeAt(): number | undefined {
    const row = this.storage.sql.exec(
      `SELECT MIN(CASE WHEN status = 'publishing' THEN lease_until ELSE next_attempt_at END) AS wake_at
       FROM ${EFFECT_TABLE} WHERE status IN ('publishing', 'retryable', 'published')`,
    ).toArray()[0];
    return row && typeof row.wake_at === 'number' ? row.wake_at : undefined;
  }

  publicationEffect(jobId: string): PublicationEffect | undefined {
    const row = this.storage.sql.exec(
      `SELECT job_id, attempts, status, claim_token, lease_until, next_attempt_at,
       last_failure_code, pull_request_number, url, head_commit, reconciliation_attempts, updated_at
       FROM ${EFFECT_TABLE} WHERE job_id = ? LIMIT 1`,
      jobId,
    ).toArray()[0];
    if (!row) return undefined;
    if (typeof row.job_id !== 'string' || typeof row.attempts !== 'number' || !Number.isSafeInteger(row.attempts)
      || (row.status !== 'publishing' && row.status !== 'retryable' && row.status !== 'published' && row.status !== 'merged'
        && row.status !== 'closed-unmerged' && row.status !== 'failed' && row.status !== 'uncertain')
      || typeof row.reconciliation_attempts !== 'number' || !Number.isSafeInteger(row.reconciliation_attempts)
      || row.reconciliation_attempts < 0
      || typeof row.updated_at !== 'string') throw new TargetJobError('publication-effect-corrupt');
    const result: PublicationEffect = {
      jobId: row.job_id,
      attempts: row.attempts,
      status: row.status,
      reconciliationAttempts: row.reconciliation_attempts,
      updatedAt: row.updated_at,
    };
    if (typeof row.last_failure_code === 'string') result.lastFailureCode = row.last_failure_code;
    if (typeof row.claim_token === 'string') result.claimToken = row.claim_token;
    if (typeof row.lease_until === 'number') result.leaseUntil = row.lease_until;
    if (typeof row.next_attempt_at === 'number') result.nextAttemptAt = row.next_attempt_at;
    if (typeof row.pull_request_number === 'number') result.pullRequestNumber = row.pull_request_number;
    if (typeof row.url === 'string') result.url = row.url;
    if (typeof row.head_commit === 'string') result.headCommit = row.head_commit;
    return result;
  }

  private readJob(query: string, value: string): JobRecord | undefined {
    const row = this.storage.sql.exec(query, value).toArray()[0];
    return row ? parseJobJson(row.record_json) : undefined;
  }
}

function identityHash(installationId: number, targetFullName: string, baseBranch: string): Promise<string> {
  const identity = [String(installationId), targetFullName.toLowerCase(), baseBranch].join('\u0000');
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)).then(bytes =>
    [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}

function targetIdentityHash(registration: TrackingRegistration): Promise<string> {
  return identityHash(registration.installationId, registration.target.fullName, registration.baseBranch);
}

function planIdentityHash(plan: PinnedPlan): Promise<string> {
  return identityHash(plan.installationId, plan.target.fullName, plan.baseBranch);
}

/** Deterministic namespace key: one SQLite/OpenCode host per installation, target, and base. */
export async function jobInstanceName(registration: TrackingRegistration): Promise<string> {
  return `target-${await targetIdentityHash(registration)}`;
}

function verifiedProposal(job: JobRecord): VerifiedJobProposal {
  const proposal = job.proposal;
  if (!proposal || !proposal.verification || proposal.verification.status !== 'passed') {
    throw new TargetJobError('job-not-verified-for-publication');
  }
  return { ...proposal, verification: proposal.verification };
}

function withJobUpdate(job: JobRecord, update: Partial<Pick<JobRecord, 'status' | 'stage' | 'failure' | 'proposal'>>): JobRecord {
  return {
    ...job,
    ...update,
    version: job.version + 1,
    updatedAt: nowIso(),
  };
}

/** A persisted interrupted core turn is terminal; resubmitting it would repeat model/tool work. */
export function markInterruptedJobFailed(job: JobRecord, at = nowIso()): JobRecord {
  if (!RUNNING_STATUSES.includes(job.status)) throw new TargetJobError('job-not-interrupted');
  return {
    ...job,
    status: 'failed',
    stage: 'terminal',
    failure: { code: 'stale-in-progress-job' },
    version: job.version + 1,
    updatedAt: at,
  };
}

export class TargetJobDO extends DurableObject<TargetJobEnvironment> {
  private readonly durableJobs: DurableSqliteJobStore;
  private readonly registry: D1RegistryStore;
  private readonly store: StorePort;
  private readonly github: GitHubAppClient;
  private readonly runner: ReturnType<typeof createSandboxRunner>;
  private readonly initialization: Promise<void>;
  private agent: OpenCodeAgent | undefined;
  private operation: ExecutionOperation | undefined;

  constructor(ctx: TargetJobContext, env: TargetJobEnvironment) {
    super(ctx, env);
    this.durableJobs = new DurableSqliteJobStore(ctx.storage);
    this.registry = new D1RegistryStore(env.DB);
    this.store = new D1Store(this.registry, this.durableJobs);
    this.github = new GitHubAppClient({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }, {
      loadCheckpointEvidence: async candidate => {
        const job = await this.durableJobs.getJob(candidate.jobId);
        if (!job || job.key !== candidate.jobKey || job.trackingId !== candidate.trackingId
          || job.plan.policyHash !== candidate.policyHash || job.plan.targetBaseCommit !== candidate.targetBaseCommit
          || job.plan.toCommit !== candidate.upstreamCommit || !job.proposal
          || job.proposal.verification?.status !== 'passed') return undefined;
        return { plan: job.plan, proposal: verifiedProposal(job) };
      },
    });
    this.runner = createSandboxRunner({ namespace: env.SANDBOX });
    this.initialization = ctx.blockConcurrencyWhile(async () => {
      // OpenCode owns the first schema migrations on this SQLite database. The
      // SDK rejects a non-empty database without its session table, so app-owned
      // tables must be created only after the real Workerd host has initialized.
      await this.createAgentHost();
      this.durableJobs.initialize();
    });
  }

  /** Queue RPC. The Worker passes identity only; approved policy is loaded from D1. */
  runTracking(trackingId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(trackingId)) throw new TargetJobError('tracking-id-invalid');
    const current = this.operation;
    if (current) {
      if (current.kind === 'run' && current.trackingId === trackingId) return current.promise;
      throw new TargetJobError('target-job-busy');
    }
    const generationId = crypto.randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    const initialDeadline = startedAt + MAX_POLICY_JOB_SECONDS * 1_000 + PUBLICATION_WAIT_LIMIT_MS;
    this.durableJobs.beginRun(generationId, trackingId, initialDeadline);
    const run: RunContext = { generationId, trackingId, startedAt, deadlineAt: initialDeadline, controller };
    const promise = this.runTrackingInternal(run);
    const tracked = promise.finally(() => {
      if (this.operation?.promise === tracked) this.operation = undefined;
    });
    this.operation = { kind: 'run', trackingId, generationId, deadlineAt: initialDeadline, controller, promise: tracked };
    return tracked;
  }

  /** PR/merge webhook RPC. It only reads GitHub state; webhook payload data is not trusted. */
  reconcileTracking(trackingId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(trackingId)) throw new TargetJobError('tracking-id-invalid');
    if (this.operation) {
      if (this.operation.kind === 'reconcile' && this.operation.trackingId === trackingId) return this.operation.promise;
      throw new TargetJobError('target-job-busy');
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + PUBLICATION_WAIT_LIMIT_MS;
    const promise = this.reconcileInternal(trackingId, controller, deadlineAt).catch(async error => {
      await this.scheduleOutstandingWork().catch(() => undefined);
      throw error;
    });
    const tracked = promise.finally(() => {
      if (this.operation?.promise === tracked) this.operation = undefined;
    });
    this.operation = { kind: 'reconcile', trackingId, controller, deadlineAt, promise: tracked };
    return tracked;
  }

  /** Optional operator/internal RPC for a verified cancellation request. */
  async cancelTracking(trackingId: string): Promise<boolean> {
    const state = this.durableJobs.requestRunCancellation(trackingId, 'operator-cancelled');
    if (!state) return false;
    await this.setAlarmBounded(Date.now() + 1_000).catch(() => undefined);
    const operation = this.operation;
    if (operation?.generationId === state.generationId) operation.controller?.abort();
    await this.terminalizeGeneration(state.generationId, 'operator-cancelled');
    return true;
  }

  private async expireGeneration(generationId: string, code: string): Promise<void> {
    const state = this.durableJobs.runState();
    if (!state || state.generationId !== generationId || state.status !== 'active') return;
    this.durableJobs.cancelRunGeneration(generationId, code);
    const operation = this.operation;
    if (operation?.generationId === generationId) operation.controller?.abort();
    await this.terminalizeGeneration(generationId, code);
  }

  private async terminalizeGeneration(generationId: string, code: string): Promise<void> {
    const state = this.durableJobs.runState();
    if (!state || state.generationId !== generationId || state.status !== 'active') return;
    this.durableJobs.cancelRunGeneration(generationId, code);
    const jobs = this.durableJobs.listByTrackingStatuses(state.trackingId, [
      'queued', 'running', 'ready-to-publish', 'publishing',
    ], 17);
    for (const job of jobs.slice(0, 16)) {
      const effect = job.status === 'publishing' ? this.durableJobs.publicationEffect(job.id) : undefined;
      if (effect?.status === 'published' && effect.pullRequestNumber !== undefined && effect.url && effect.headCommit) {
        this.durableJobs.repairPublishedJob(job, {
          pullRequestNumber: effect.pullRequestNumber,
          url: effect.url,
          headCommit: effect.headCommit,
        });
        continue;
      }
      const uncertainPublication = effect?.status === 'publishing' || effect?.status === 'uncertain';
      if (effect?.status === 'publishing') {
        this.durableJobs.markPublicationUncertain(job.id, effect.claimToken, 'cancelled-during-publication');
      }
      const terminalStatus = uncertainPublication ? 'failed' : code === 'operator-cancelled' ? 'cancelled' : 'failed';
      const failureCode = uncertainPublication ? 'publication-outcome-uncertain' : code.slice(0, 64);
      const sessionID = this.durableJobs.sessionForJob(job.id);
      try {
        const terminal = this.durableJobs.markJobTerminalWithCleanup(job, terminalStatus, failureCode, sessionID);
        if (terminal.status === 'failed' && effect && !uncertainPublication) {
          this.durableJobs.markPublicationFailed(job.id, failureCode);
        }
      } catch (error) {
        const fresh = await boundedPromise(this.store.getJob(job.id), CANCEL_CLEANUP_WAIT_MS, 'terminal-job-read-timeout');
        if (fresh && !['failed', 'cancelled'].includes(fresh.status)) throw error;
      }
    }
    const runStatus = code === 'operator-cancelled' ? 'cancelled' : code === 'job-deadline-exceeded' ? 'expired' : 'failed';
    this.durableJobs.finishRun(generationId, runStatus, code);
    await this.cancelRunResources(state.trackingId, generationId);
    if (jobs.length > 16) await this.setAlarmBounded(Date.now() + 1_000);
    else await this.scheduleOutstandingWork();
  }

  private async cancelRunResources(trackingId: string, generationId: string): Promise<void> {
    const state = this.durableJobs.runState();
    if (!state || state.generationId !== generationId || state.trackingId !== trackingId || !state.jobId) return;
    const job = await boundedPromise(this.store.getJob(state.jobId), CANCEL_CLEANUP_WAIT_MS, 'cancel-job-read-timeout')
      .catch(() => undefined);
    if (job?.status === 'publishing') return;
    this.durableJobs.requestSandboxCleanup(state.jobId);
    await boundedPromise(this.agent?.cancel(state.jobId) ?? Promise.resolve(), CANCEL_CLEANUP_WAIT_MS, 'agent-cancel-timeout')
      .catch(() => undefined);
    try {
      await boundedPromise(this.runner.cancel(state.jobId), CANCEL_CLEANUP_WAIT_MS, 'sandbox-cancel-timeout');
      this.durableJobs.completeSandboxCleanup(state.jobId);
    } catch {
      // The cleanup outbox survives and is retried by alarms.
    }
    const sessionID = this.durableJobs.sessionForJob(state.jobId);
    if (sessionID) {
      this.durableJobs.requestSessionCleanup(state.jobId, sessionID);
      try {
        if (await boundedPromise(this.agent?.removeSession(sessionID) ?? Promise.resolve(false), CANCEL_CLEANUP_WAIT_MS, 'session-cancel-timeout')) {
          this.durableJobs.completeSessionCleanup(sessionID);
        }
      } catch {
        // The durable session cleanup marker is retained for the alarm path.
      }
    }
  }

  private async finishRunSuccessfully(run: RunContext): Promise<boolean> {
    if (this.durableJobs.finishRun(run.generationId, 'completed')) return true;
    const current = this.durableJobs.runState();
    if (current?.generationId === run.generationId && current.status === 'active') {
      const code = current.cancelCode ?? (current.deadlineAt <= Date.now()
        ? 'job-deadline-exceeded'
        : 'job-run-generation-ended');
      await this.terminalizeGeneration(run.generationId, code);
    }
    return false;
  }

  override alarm(): Promise<void> {
    const state = this.durableJobs.runState();
    if (state?.status === 'active' && state.cancelRequested) {
      if (this.operation?.generationId === state.generationId) this.operation.controller?.abort();
      return this.terminalizeGeneration(state.generationId, state.cancelCode ?? 'operator-cancelled');
    }
    if (state?.status === 'active' && state.deadlineAt <= Date.now()) {
      return this.expireGeneration(state.generationId, 'job-deadline-exceeded');
    }
    const current = this.operation;
    if (current) {
      if (current.deadlineAt !== undefined && current.deadlineAt <= Date.now()) {
        if (current.generationId) return this.expireGeneration(current.generationId, 'job-deadline-exceeded');
        current.controller?.abort();
        return this.expireOperation(current);
      }
      const due = this.durableJobs.earliestPublicationWakeAt();
      const next = Math.min(
        current.deadlineAt ?? Date.now() + 60_000,
        due ?? Date.now() + 60_000,
        Date.now() + 60_000,
      );
      return this.setAlarmBounded(next);
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + PUBLICATION_WAIT_LIMIT_MS;
    const promise = this.alarmInternal(controller, deadlineAt).catch(async error => {
      await this.scheduleOutstandingWork().catch(() => undefined);
      throw error;
    });
    const tracked = promise.finally(() => {
      if (this.operation?.promise === tracked) this.operation = undefined;
    });
    this.operation = { kind: 'alarm', controller, deadlineAt, promise: tracked };
    return tracked;
  }

  private async expireOperation(operation: ExecutionOperation): Promise<void> {
    operation.controller?.abort();
    await boundedPromise(operation.promise, CANCEL_CLEANUP_WAIT_MS, 'operation-watchdog-timeout').catch(() => undefined);
    if (this.operation === operation) this.operation = undefined;
    await this.scheduleOutstandingWork();
  }

  private setAlarmBounded(timestamp: number): Promise<void> {
    return boundedPromise(
      Promise.resolve().then(() => this.ctx.storage.setAlarm(timestamp)),
      5_000,
      'alarm-storage-timeout',
    );
  }

  private deleteAlarmBounded(): Promise<void> {
    return boundedPromise(
      Promise.resolve().then(() => this.ctx.storage.deleteAlarm()),
      5_000,
      'alarm-storage-timeout',
    );
  }

  private async reconcileInternal(trackingId: string, controller: AbortController, deadlineAt: number): Promise<void> {
    const guard: OperationGuard = { controller, deadlineAt };
    await this.awaitOperation(this.initialization, controller, deadlineAt, 'initialization-timeout');
    const registration = await this.awaitOperation(
      this.store.getTrackingRegistration(trackingId), controller, deadlineAt, 'registration-read-timeout',
    );
    if (registration) this.durableJobs.bindTargetIdentity(await targetIdentityHash(registration));
    const unresolved = await this.recoverPublications(trackingId, guard);
    const more = await this.activateMergedJobs(trackingId, guard);
    if (unresolved) await this.scheduleRetryAlarm();
    else if (more) await this.setAlarmBounded(Date.now() + 1_000);
    else await this.clearAlarmWhenIdle();
  }

  private async alarmInternal(controller: AbortController, deadlineAt: number): Promise<void> {
    const guard: OperationGuard = { controller, deadlineAt };
    await this.awaitOperation(this.initialization, controller, deadlineAt, 'initialization-timeout');
    const runState = this.durableJobs.runState();
    if (runState?.status === 'active') {
      if (runState.cancelRequested) {
        await this.terminalizeGeneration(runState.generationId, runState.cancelCode ?? 'operator-cancelled');
        return;
      }
      if (runState.deadlineAt <= Date.now()) {
        await this.expireGeneration(runState.generationId, 'job-deadline-exceeded');
        return;
      }
      await this.setAlarmBounded(Math.min(runState.deadlineAt, Date.now() + 60_000));
      return;
    }
    const moreInterrupted = await this.recoverInterruptedJobs();
    if (moreInterrupted || await this.recoverSandboxCleanups() || await this.recoverSessionCleanups()) {
      await this.setAlarmBounded(Date.now() + 60_000);
      return;
    }
    const pending = await this.recoverPublications(undefined, guard);
    const moreReconcile = await this.reconcilePublishedSweep(guard);
    if (pending) await this.scheduleRetryAlarm();
    else if (moreReconcile) await this.setAlarmBounded(Date.now() + 1_000);
    else await this.clearAlarmWhenIdle();
  }

  private async createAgentHost(): Promise<void> {
    if (this.agent) return;
    const hostPromise = createOpenCodeAgent({
      storage: this.ctx.storage,
      provider: resolveHostedProviderEnvironment(this.env),
      loadProtectedPaths: async request => {
        const registration = await this.registry.getTrackingRegistration(request.plan.trackingId);
        if (!registration || !registration.active || registration.policyHash !== request.plan.policyHash) {
          throw new TargetJobError('agent-registration-changed');
        }
        return parsePolicy(registration.policy).protectedPaths;
      },
      persistSessionCreated: (jobId, sessionID) => this.durableJobs.persistSessionStarted(jobId, sessionID),
      persistSessionRemoved: sessionID => this.durableJobs.completeSessionCleanup(sessionID),
      persistSessionCleanup: (jobId, sessionID) => this.durableJobs.requestSessionCleanup(jobId, sessionID),
    });
    try {
      this.agent = await boundedPromise(hostPromise, MAX_INIT_WAIT_MS, 'opencode-host-init-timeout');
    } catch {
      void hostPromise.then(agent => agent.close()).catch(() => undefined);
      throw new TargetJobError('opencode-host-init-failed');
    }
  }

  private ports(): CorePorts {
    if (!this.agent) throw new TargetJobError('opencode-host-unavailable');
    return {
      store: this.store,
      github: this.github,
      agent: this.agent,
      runner: this.runner,
    };
  }

  private assertRunActive(run: RunContext): void {
    const state = this.durableJobs.runState();
    if (!state || state.generationId !== run.generationId || state.status !== 'active') {
      throw new TargetJobError(state?.cancelCode ?? 'run-generation-ended');
    }
    if (state.cancelRequested || run.controller.signal.aborted) {
      throw new TargetJobError(state.cancelCode ?? 'operator-cancelled');
    }
    if (Date.now() >= state.deadlineAt) throw new TargetJobError('job-deadline-exceeded');
    run.deadlineAt = Math.min(run.deadlineAt, state.deadlineAt);
  }

  private async awaitOperation<T>(promise: Promise<T>, controller: AbortController, deadlineAt: number, code: string): Promise<T> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new TargetJobError(code);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new TargetJobError('operation-cancelled'));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TargetJobError(code));
      }, remainingMs);
    });
    try {
      return await Promise.race([promise, cancelled, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private assertGuard(guard: OperationGuard | RunContext): void {
    if ('startedAt' in guard) {
      this.assertRunActive(guard);
      return;
    }
    if (guard.controller.signal.aborted) throw new TargetJobError('operation-cancelled');
    if (Date.now() >= guard.deadlineAt) throw new TargetJobError('operation-deadline-exceeded');
  }

  private guardCancelled(guard: OperationGuard | RunContext): boolean {
    if (guard.controller.signal.aborted || Date.now() >= guard.deadlineAt) return true;
    if ('startedAt' in guard) {
      const state = this.durableJobs.runState();
      return !state || state.generationId !== guard.generationId || state.status !== 'active' || state.cancelRequested;
    }
    return false;
  }

  private async awaitGuard<T>(guard: OperationGuard | RunContext, promise: Promise<T>): Promise<T> {
    if ('startedAt' in guard) return this.awaitRun(guard, promise);
    const result = await this.awaitOperation(promise, guard.controller, guard.deadlineAt, 'operation-deadline-exceeded');
    this.assertGuard(guard);
    return result;
  }

  private async awaitRun<T>(run: RunContext, promise: Promise<T>): Promise<T> {
    this.assertRunActive(run);
    const remainingMs = Math.max(1, Math.min(run.deadlineAt, this.durableJobs.runState()?.deadlineAt ?? run.deadlineAt) - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new TargetJobError('operator-cancelled'));
      if (run.controller.signal.aborted) onAbort();
      else run.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new TargetJobError('job-deadline-exceeded'));
        this.durableJobs.cancelRunGeneration(run.generationId, 'job-deadline-exceeded');
        run.controller.abort();
        void this.expireGeneration(run.generationId, 'job-deadline-exceeded').catch(() => undefined);
      }, remainingMs);
    });
    try {
      const result = await Promise.race([promise, cancelled, deadline]);
      this.assertRunActive(run);
      return result;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) run.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private portsForGuard(guard: OperationGuard | RunContext): CorePorts {
    const ports = this.ports();
    const github: GitHubPort = {
      verifyTrackingAccess: input => this.awaitGuard(guard, ports.github.verifyTrackingAccess(input)),
      discoverPlan: (registration, policy) => this.awaitGuard(guard, ports.github.discoverPlan(registration, policy)),
      readSourceSnapshot: input => this.awaitGuard(guard, ports.github.readSourceSnapshot(input)),
      readTargetSnapshot: input => this.awaitGuard(guard, ports.github.readTargetSnapshot(input)),
      readVerificationWorkspace: input => this.awaitGuard(guard, ports.github.readVerificationWorkspace(input)),
      publishDraft: input => this.awaitGuard(guard, ports.github.publishDraft(input)),
      confirmMergedCheckpoint: input => this.awaitGuard(guard, ports.github.confirmMergedCheckpoint(input)),
      getPullRequestLifecycle: input => this.awaitGuard(guard, ports.github.getPullRequestLifecycle(input)),
    };
    const store: StorePort = {
      createTrackingRegistration: input => ports.store.createTrackingRegistration(input),
      getTrackingRegistration: id => this.awaitGuard(guard, ports.store.getTrackingRegistration(id)),
      listActiveTrackingRegistrations: input => ports.store.listActiveTrackingRegistrations(input),
      setTrackingRegistrationActive: input => ports.store.setTrackingRegistrationActive(input),
      recordWebhookDelivery: input => ports.store.recordWebhookDelivery(input),
      createOrGetJob: async input => {
        if (!('startedAt' in guard)) throw new TargetJobError('job-admission-not-allowed');
        this.assertRunActive(guard);
        return this.durableJobs.createOrGetJobForRun(guard.generationId, input);
      },
      getJob: id => this.awaitGuard(guard, ports.store.getJob(id)),
      getJobByKey: key => this.awaitGuard(guard, ports.store.getJobByKey(key)),
      listJobsForCumulativeRange: input => this.awaitGuard(guard, ports.store.listJobsForCumulativeRange(input)),
      listJobsForSyncOrigin: input => this.awaitGuard(guard, ports.store.listJobsForSyncOrigin(input)),
      saveJob: (record, expectedVersion) => {
        this.assertGuard(guard);
        return this.awaitGuard(guard, ports.store.saveJob(record, expectedVersion));
      },
      advanceLastCheckedCommit: input => this.awaitGuard(guard, ports.store.advanceLastCheckedCommit(input)),
      activateLastSyncedCommit: input => this.awaitGuard(guard, ports.store.activateLastSyncedCommit(input)),
    };
    const agent: CorePorts['agent'] = {
      run: input => this.awaitGuard(guard, ports.agent.run(input)),
    };
    const runner: CorePorts['runner'] = {
      verify: async (input: RunnerRequest) => {
        if (!('startedAt' in guard)) throw new TargetJobError('verification-not-allowed');
        this.assertRunActive(guard);
        this.durableJobs.requestSandboxCleanup(input.jobId);
        try {
          const result = await this.awaitRun(guard, ports.runner.verify(input));
          this.durableJobs.completeSandboxCleanup(input.jobId);
          return result;
        } catch {
          void this.setAlarmBounded(Date.now() + 1_000).catch(() => undefined);
          this.durableJobs.requestSandboxCleanup(input.jobId);
          throw new TargetJobError('verification-boundary-failed');
        }
      },
    };
    return { store, github, agent, runner };
  }

  private async runTrackingInternal(run: RunContext): Promise<void> {
    try {
      await this.awaitRun(run, boundedPromise(
        this.ctx.storage.setAlarm(run.deadlineAt + JOB_ALARM_GRACE_MS),
        5_000,
        'run-alarm-schedule-timeout',
      ));
      await this.awaitRun(run, boundedPromise(this.initialization, MAX_INIT_WAIT_MS, 'opencode-host-init-timeout'));
      this.assertRunActive(run);
      const registration = await this.awaitRun(run, this.store.getTrackingRegistration(run.trackingId));
      if (!registration || !registration.active) throw new TargetJobError('tracking-registration-inactive');
      this.durableJobs.bindTargetIdentity(await targetIdentityHash(registration));
      const policy = parsePolicy(registration.policy);
      run.deadlineAt = Math.min(
        run.deadlineAt,
        run.startedAt + policy.limits.maxJobSeconds * 1_000 + PUBLICATION_WAIT_LIMIT_MS,
      );
      if (!this.durableJobs.updateRunDeadline(run.generationId, run.deadlineAt)) throw new TargetJobError('job-run-cancelled');
      if (this.operation?.generationId === run.generationId) this.operation.deadlineAt = run.deadlineAt;
      await this.setAlarmBounded(run.deadlineAt + JOB_ALARM_GRACE_MS);

      const moreInterrupted = await this.recoverInterruptedJobs();
      if (moreInterrupted || await this.recoverSandboxCleanups() || await this.recoverSessionCleanups()) {
        await this.finishRunSuccessfully(run);
        await this.setAlarmBounded(Date.now() + 60_000);
        return;
      }

      // Resume durable external effects before discovery; discovery may now say
      // up-to-date because the checked marker already advanced before eviction.
      const pending = await this.recoverPublications(undefined, run);
      if (pending) {
        await this.finishRunSuccessfully(run);
        await this.scheduleRetryAlarm();
        return;
      }
      if (await this.activateMergedJobs(run.trackingId, run)
        || this.durableJobs.hasPublishedLifecycleJobs(run.trackingId)) {
        await this.finishRunSuccessfully(run);
        await this.scheduleRetryAlarm();
        return;
      }
      this.assertRunActive(run);

      const result: JobRunResult = await this.awaitRun(run, runCoreJob(run.trackingId, this.portsForGuard(run)));
      this.assertRunActive(run);
      if (result.status === 'ready-to-publish') {
        const outcome = await this.publishJob(result.job, run);
        if (outcome !== 'completed') await this.scheduleRetryAlarm();
      }
      this.assertRunActive(run);
      if (await this.activateMergedJobs(run.trackingId, run)) {
        if (!await this.finishRunSuccessfully(run)) return;
        await this.scheduleRetryAlarm();
        return;
      }
      if (!await this.finishRunSuccessfully(run)) return;
      await this.clearAlarmWhenIdle();
    } catch (error) {
      const state = this.durableJobs.runState();
      if (state?.generationId === run.generationId && (state.cancelRequested || Date.now() >= state.deadlineAt)) {
        await this.terminalizeGeneration(run.generationId, state.cancelCode ?? 'job-deadline-exceeded');
        return;
      }
      await this.terminalizeGeneration(run.generationId, sanitizedFailure(error));
      throw new TargetJobError(sanitizedFailure(error));
    }
  }

  /** Fail in-flight app work after an eviction instead of replaying a model call. */
  private async recoverInterruptedJobs(): Promise<boolean> {
    const page = this.durableJobs.listByStatuses(RUNNING_STATUSES, 16);
    for (const job of page) {
      this.durableJobs.bindTargetIdentity(await planIdentityHash(job.plan));
      const sessionID = this.durableJobs.sessionForJob(job.id);
      const failed = markInterruptedJobFailed(job);
      this.durableJobs.terminalizeJobWithCleanup(failed, job.version, sessionID);
    }
    return page.length === 16;
  }

  /** Retry job-owned container cleanup after a DO eviction interrupted `finally`. */
  private async recoverSandboxCleanups(): Promise<boolean> {
    const jobIds = this.durableJobs.pendingSandboxCleanup(3);
    let unresolved = false;
    for (const jobId of jobIds) {
      try {
        await boundedPromise(this.agent?.cancel(jobId) ?? Promise.resolve(), CANCEL_CLEANUP_WAIT_MS, 'agent-cancel-timeout');
        await boundedPromise(this.runner.cancel(jobId), CANCEL_CLEANUP_WAIT_MS, 'sandbox-cancel-timeout');
        this.durableJobs.completeSandboxCleanup(jobId);
      } catch {
        unresolved = true;
      }
    }
    return unresolved || this.durableJobs.pendingSandboxCleanup(1).length > 0;
  }

  private async recoverSessionCleanups(): Promise<boolean> {
    const sessions = this.durableJobs.pendingSessionCleanup(3);
    let unresolved = false;
    for (const item of sessions) {
      try {
        if (!await this.agent?.removeSession(item.sessionID)) {
          unresolved = true;
          continue;
        }
        this.durableJobs.completeSessionCleanup(item.sessionID);
      } catch {
        unresolved = true;
      }
    }
    return unresolved || this.durableJobs.pendingSessionCleanup(1).length > 0;
  }

  /** Returns true when a retry is due later or a bounded page remains. */
  private async recoverPublications(trackingId: string | undefined, guard: OperationGuard | RunContext): Promise<boolean> {
    const cursorName = trackingId ? `publication:${trackingId}` : 'publication:all';
    let deferred = false;
    for (let pageIndex = 0; pageIndex < RECONCILE_PAGES_PER_CALL; pageIndex++) {
      this.assertGuard(guard);
      const page = trackingId
        ? this.durableJobs.listByTrackingStatusesPage(trackingId, cursorName, PUBLICATION_STATUSES, RECONCILE_PAGE_SIZE)
        : this.durableJobs.listByStatusesPage(cursorName, PUBLICATION_STATUSES, RECONCILE_PAGE_SIZE);
      for (const job of page.jobs) {
        this.assertGuard(guard);
        const outcome = await this.publishJob(job, guard);
        if (outcome === 'deferred') deferred = true;
      }
      if (!page.more) return deferred;
    }
    return true;
  }

  private async publishJob(initial: JobRecord, guard: OperationGuard | RunContext): Promise<'completed' | 'deferred'> {
    this.assertGuard(guard);
    let job = await this.store.getJob(initial.id);
    this.assertGuard(guard);
    if (!job || !PUBLICATION_STATUSES.includes(job.status)) return 'completed';
    this.durableJobs.bindTargetIdentity(await planIdentityHash(job.plan));
    const proposal = verifiedProposal(job);
    const recordedEffect = this.durableJobs.publicationEffect(job.id);
    if (recordedEffect?.status === 'published') {
      const pullRequestNumber = recordedEffect.pullRequestNumber;
      if (typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber)
        || !recordedEffect.url || !recordedEffect.headCommit) {
        throw new TargetJobError('publication-effect-corrupt');
      }
      const completed: DraftPublication = {
        pullRequestNumber,
        url: recordedEffect.url,
        headCommit: recordedEffect.headCommit,
      };
      if (!validPublication(completed)) throw new TargetJobError('publication-effect-corrupt');
      this.durableJobs.repairPublishedJob(job, completed);
      return 'completed';
    }
    const registration = await this.awaitGuard(guard, this.store.getTrackingRegistration(job.trackingId));
    if (!registration || !registration.active || registration.policyHash !== job.plan.policyHash) {
      job = withJobUpdate(job, { status: 'failed', stage: 'terminal', failure: { code: 'inactive-before-publication' } });
      await this.store.saveJob(job, job.version - 1);
      this.durableJobs.markPublicationFailed(job.id, 'inactive-before-publication');
      return 'completed';
    }
    this.durableJobs.bindTargetIdentity(await targetIdentityHash(registration));
    if (registration.installationId !== job.plan.installationId
      || registration.target.fullName.toLowerCase() !== job.plan.target.fullName.toLowerCase()
      || registration.baseBranch !== job.plan.baseBranch) {
      throw new TargetJobError('publication-target-mismatch');
    }

    this.assertGuard(guard);
    const checked = await this.awaitGuard(guard, this.store.advanceLastCheckedCommit({
      trackingId: registration.id,
      expectedLastCheckedCommit: job.plan.expectedLastCheckedCommit,
      nextLastCheckedCommit: job.plan.toCommit,
      policyHash: job.plan.policyHash,
    }));
    if (!checked) {
      const fresh = await this.awaitGuard(guard, this.store.getTrackingRegistration(registration.id));
      if (!fresh || fresh.lastCheckedCommit !== job.plan.toCommit) {
        const failed = withJobUpdate(job, { status: 'failed', stage: 'terminal', failure: { code: 'checked-commit-conflict' } });
        await this.store.saveJob(failed, job.version);
        this.durableJobs.markPublicationFailed(job.id, 'checked-commit-conflict');
        return 'completed';
      }
    }

    if (job.status === 'ready-to-publish') {
      const publishing = withJobUpdate(job, { status: 'publishing', stage: 'publishing' });
      job = await this.store.saveJob(publishing, job.version);
    }
    this.assertGuard(guard);
    const claim = this.durableJobs.claimPublication(job.id, Date.now(), PUBLICATION_LEASE_MS);
    if (claim.kind === 'deferred') {
      await this.setAlarmBounded(claim.dueAt);
      return 'deferred';
    }
    if (claim.kind === 'operator-review') {
      const failed = withJobUpdate(job, {
        status: 'failed', stage: 'terminal', failure: { code: 'publication-outcome-uncertain' },
      });
      await this.store.saveJob(failed, job.version);
      return 'completed';
    }
    if (claim.kind === 'published') {
      const effect = claim.effect;
      if (effect.pullRequestNumber === undefined || !effect.url || !effect.headCommit) {
        throw new TargetJobError('publication-effect-corrupt');
      }
      this.durableJobs.repairPublishedJob(job, {
        pullRequestNumber: effect.pullRequestNumber,
        url: effect.url,
        headCommit: effect.headCommit,
      });
      return 'completed';
    }
    if (claim.kind === 'exhausted') {
      const failed = withJobUpdate(job, { status: 'failed', stage: 'terminal', failure: { code: 'publication-retry-limit' } });
      await this.store.saveJob(failed, job.version);
      this.durableJobs.markPublicationUncertain(job.id, undefined, 'publication-retry-limit');
      return 'completed';
    }

    let publication: DraftPublication;
    try {
      publication = await this.awaitGuard(guard, this.github.publishDraft({
        registration,
        plan: job.plan,
        proposal,
        idempotencyKey: job.plan.jobKey,
      }));
      if (!validPublication(publication)) throw new TargetJobError('publication-response-invalid');
    } catch (error) {
      const code = sanitizedFailure(error);
      if (this.guardCancelled(guard)) {
        this.durableJobs.markPublicationUncertain(job.id, claim.claimToken, 'cancelled-during-publication');
        const sessionID = this.durableJobs.sessionForJob(job.id);
        try {
          this.durableJobs.markJobTerminalWithCleanup(job, 'failed', 'publication-outcome-uncertain', sessionID);
        } catch {
          // A concurrent cancellation/watchdog may already have atomically
          // terminalized this job and registered its cleanup obligation.
        }
        return 'completed';
      }
      const dueAt = Math.max(claim.leaseUntil, Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (claim.attempt - 1)));
      if (!this.durableJobs.markPublicationRetryable(job.id, claim.claimToken, code, dueAt)) {
        this.durableJobs.markPublicationUncertain(job.id, claim.claimToken, 'publication-claim-lost');
        return 'deferred';
      }
      if (claim.attempt >= MAX_PUBLICATION_ATTEMPTS) {
        this.durableJobs.markPublicationUncertain(job.id, undefined, 'publication-retry-limit');
        const fresh = await this.store.getJob(job.id);
        if (fresh?.status === 'publishing') {
          await this.store.saveJob(withJobUpdate(fresh, { status: 'failed', stage: 'terminal', failure: { code: 'publication-retry-limit' } }), fresh.version);
        }
        return 'completed';
      }
      await this.setAlarmBounded(dueAt);
      return 'deferred';
    }
    this.assertGuard(guard);
    this.durableJobs.completePublication(job, claim.claimToken, publication);
    return 'completed';
  }

  private async activateMergedJobs(trackingId: string, guard: OperationGuard | RunContext): Promise<boolean> {
    const cursor = this.durableJobs.reconciliationCursor(trackingId);
    let unresolved = false;
    for (let pageIndex = 0; pageIndex < RECONCILE_PAGES_PER_CALL; pageIndex++) {
      this.assertGuard(guard);
      const page = this.durableJobs.listPublishedForTrackingPage(trackingId, this.durableJobs.reconciliationCursor(trackingId), RECONCILE_PAGE_SIZE);
      for (const job of page.jobs) {
        this.assertGuard(guard);
        const candidate = job.proposal?.checkpointCandidate;
        if (!candidate) continue;
        this.durableJobs.bindTargetIdentity(await planIdentityHash(job.plan));
        const effect = this.durableJobs.publicationEffect(job.id);
        const registration = await this.awaitGuard(guard, this.store.getTrackingRegistration(trackingId));
        if (!effect || effect.status !== 'published' || !effect.pullRequestNumber || !registration?.active) {
          if (effect?.status === 'published') {
            this.durableJobs.scheduleLifecycleRecheck(job.id, Date.now());
            unresolved = true;
          }
          continue;
        }
        const lifecycle = await this.awaitGuard(guard, this.github.getPullRequestLifecycle({
          registration,
          candidate,
          pullRequestNumber: effect.pullRequestNumber,
        }));
        if (lifecycle.status === 'closed-unmerged') {
          this.durableJobs.markClosedUnmerged(job, lifecycle.pullRequestNumber);
          continue;
        }
        if (lifecycle.status === 'open' || lifecycle.status === 'unknown') {
          this.durableJobs.scheduleLifecycleRecheck(
            job.id,
            Date.now(),
            lifecycle.status === 'unknown' ? lifecycle.retryAfterSeconds : undefined,
          );
          unresolved = true;
          continue;
        }

        const observation = lifecycle.observation;
        const alreadyActivated = registration.lastSyncedCommit === candidate.upstreamCommit
          && registration.policyHash === candidate.policyHash;
        const eligibleForActivation = registration.lastSyncedCommit === candidate.expectedLastSyncedCommit
          && registration.policyHash === candidate.policyHash;
        const merged = alreadyActivated || (eligibleForActivation && await this.awaitGuard(
          guard,
          activateConfirmedCheckpoint(trackingId, candidate, observation, this.store),
        ));
        if (merged) {
          const fresh = await this.awaitGuard(guard, this.store.getJob(job.id));
          if (fresh?.status === 'published') {
            this.durableJobs.markPublicationMerged(fresh, lifecycle.observation.pullRequestNumber);
          }
        } else {
          this.durableJobs.scheduleLifecycleRecheck(job.id, Date.now());
          unresolved = true;
        }
      }
      if (page.jobs.length === RECONCILE_PAGE_SIZE && page.lastJobId) {
        this.durableJobs.setReconciliationCursor(trackingId, page.lastJobId);
      } else {
        this.durableJobs.clearReconciliationCursor(trackingId);
        return unresolved;
      }
    }
    void cursor;
    return true;
  }

  private async reconcilePublishedSweep(guard: OperationGuard): Promise<boolean> {
    for (let page = 0; page < RECONCILE_PAGES_PER_CALL; page++) {
      this.assertGuard(guard);
      const after = this.durableJobs.reconciliationSweepCursor();
      const trackingPage = this.durableJobs.listPublishedTrackingIds(after, RECONCILE_TRACKING_PAGE_SIZE);
      if (trackingPage.trackingIds.length === 0) {
        this.durableJobs.setReconciliationSweepCursor(undefined);
        return false;
      }
      for (const trackingId of trackingPage.trackingIds) {
        this.assertGuard(guard);
        const moreForTracking = await this.activateMergedJobs(trackingId, guard);
        if (moreForTracking) return true;
        this.durableJobs.setReconciliationSweepCursor(trackingId);
      }
      if (!trackingPage.more) {
        this.durableJobs.setReconciliationSweepCursor(undefined);
        return false;
      }
    }
    return true;
  }

  private async scheduleRetryAlarm(): Promise<void> {
    const dueAt = this.durableJobs.earliestPublicationWakeAt();
    await this.setAlarmBounded(Math.max(Date.now() + 1_000, dueAt ?? Date.now() + RETRY_MIN_MS));
  }

  private async clearAlarmWhenIdle(): Promise<void> {
    await this.scheduleOutstandingWork();
  }

  private async scheduleOutstandingWork(): Promise<void> {
    const now = Date.now();
    const run = this.durableJobs.runState();
    if (run?.status === 'active') {
      await this.setAlarmBounded(run.cancelRequested ? now + 1_000 : run.deadlineAt + JOB_ALARM_GRACE_MS);
      return;
    }
    const hasCleanup = this.durableJobs.pendingSandboxCleanup(1).length > 0
      || this.durableJobs.pendingSessionCleanup(1).length > 0;
    const hasInterrupted = this.durableJobs.listByStatuses(RUNNING_STATUSES, 1).length > 0;
    const hasPublication = this.durableJobs.listByStatuses(PUBLICATION_STATUSES, 1).length > 0;
    const hasReconcileCursor = this.durableJobs.hasReconciliationCursors()
      || this.durableJobs.reconciliationSweepCursor() !== undefined;
    if (hasCleanup || hasInterrupted || hasReconcileCursor) {
      await this.setAlarmBounded(now + 1_000);
      return;
    }
    if (hasPublication) {
      await this.scheduleRetryAlarm();
      return;
    }
    const lifecycleWake = this.durableJobs.earliestPublicationWakeAt();
    if (lifecycleWake !== undefined) {
      await this.setAlarmBounded(Math.max(now + 1_000, lifecycleWake));
      return;
    }
    await this.deleteAlarmBounded();
  }
}

export type { VerifiedJobProposal };
