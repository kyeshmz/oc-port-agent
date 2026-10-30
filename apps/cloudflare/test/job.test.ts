import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentOutput,
  AgentPort,
  CheckpointCandidate,
  CorePorts,
  DiscoveredPlan,
  GitHubPort,
  JobRecord,
  NewJobRecord,
  PinnedPlan,
  PullRequestLifecycle,
  RunnerPort,
  RunnerRequest,
  SourceSnapshot,
  StorePort,
  SyncedCommitActivation,
  TrackingRegistration,
  TargetSnapshot,
  VerificationResult,
  VerificationWorkspaceSnapshot,
  VerifiedMergeObservation,
} from '../src/contracts.js';
import {
  DurableSqliteJobStore,
  TargetJobDO,
  TargetJobError,
  jobInstanceName,
  markInterruptedJobFailed,
  type DurableJobSqlPort,
  type TargetJobEnvironment,
} from '../src/job.js';
import { resolveHostedProviderEnvironment } from '../src/provider.js';
import { createOpenCodeAgent } from '../src/opencode.js';
import { activateConfirmedCheckpoint } from '../src/core.js';
import { runJob } from '../src/core.js';
import { DEFAULT_LIMITS, parsePolicy, policyHash } from '../src/policy.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(ctx: unknown, env: unknown) { Object.assign(this, { ctx, env }); }
  },
}));

vi.mock('../src/opencode.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/opencode.js')>(),
  createOpenCodeAgent: vi.fn(),
}));

const timestamp = '2026-10-09T12:00:00.000Z';
const plan: PinnedPlan = {
  trackingId: 'tracking-1',
  installationId: 8,
  target: { owner: 'org', name: 'target', fullName: 'org/target' },
  baseBranch: 'main',
  targetBaseCommit: 'b'.repeat(40),
  upstreamRepository: 'https://github.com/upstream/project.git',
  upstreamRef: 'main',
  fromCommit: 'c'.repeat(40),
  expectedLastCheckedCommit: 'c'.repeat(40),
  toCommit: 'a'.repeat(40),
  commitCount: 1,
  changedFiles: [{ path: 'src/parser.ts', status: 'modified' }],
  changedPaths: ['src/parser.ts'],
  checkedChangedPaths: ['src/parser.ts'],
  observedAt: timestamp,
  jobId: 'job-1',
  jobKey: 'job-1',
  policyHash: 'd'.repeat(64),
  selectedUpstreamPaths: ['src/parser.ts'],
  checkedSelectedUpstreamPaths: ['src/parser.ts'],
  selectedSelectionIds: ['parser'],
};

type SqlStoragePort = DurableJobSqlPort['sql'];

class FakeSqlite implements SqlStoragePort {
  readonly jobs = new Map<string, { jobKey: string; trackingId: string; status: string; stage: string; version: number; updatedAt: string; recordJson: string }>();
  readonly effects = new Map<string, {
    jobId: string;
    attempts: number;
    status: string;
    claimToken: string | null;
    leaseUntil: number | null;
    nextAttemptAt: number | null;
    reconciliationAttempts: number;
    lastFailureCode: string | null;
    pullRequestNumber: number | null;
    url: string | null;
    headCommit: string | null;
    updatedAt: string;
  }>();
  readonly cleanupRequests = new Set<string>();
  readonly reconciliationCursors = new Map<string, string>();
  identityHash: string | undefined;
  run: {
    generation_id: string;
    tracking_id: string;
    job_id: string | null;
    status: string;
    deadline_at: number;
    cancel_requested: number;
    cancel_code: string | null;
  } | undefined;

  exec(query: string, ...bindings: unknown[]) {
    const sql = query.replace(/\s+/g, ' ').trim();
    let rows: Record<string, string | number | null | ArrayBuffer>[] = [];

    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX') || sql.startsWith('ALTER TABLE')) {
      rows = [];
    } else if (sql.startsWith('PRAGMA table_info')) {
      rows = [];
    } else if (sql.includes('SELECT identity_hash FROM ocpa_job_target_identity')) {
      rows = this.identityHash ? [{ identity_hash: this.identityHash }] : [];
    } else if (sql.startsWith('INSERT INTO ocpa_job_target_identity')) {
      this.identityHash = this.stringBinding(bindings, 0);
    } else if (sql.includes('SELECT record_json FROM ocpa_job_records WHERE id =')) {
      const job = this.jobs.get(this.stringBinding(bindings, 0));
      rows = job ? [{ record_json: job.recordJson }] : [];
    } else if (sql.includes('SELECT record_json FROM ocpa_job_records WHERE job_key =')) {
      const key = this.stringBinding(bindings, 0);
      const job = [...this.jobs.values()].find(item => item.jobKey === key);
      rows = job ? [{ record_json: job.recordJson }] : [];
    } else if (sql.startsWith('INSERT INTO ocpa_job_records')) {
      const id = this.stringBinding(bindings, 0);
      const jobKey = this.stringBinding(bindings, 1);
      const trackingId = this.stringBinding(bindings, 2);
      const status = this.stringBinding(bindings, 3);
      const stage = this.stringBinding(bindings, 4);
      const version = this.numberBinding(bindings, 5);
      const updatedAt = this.stringBinding(bindings, 6);
      const recordJson = this.stringBinding(bindings, 7);
      if (this.jobs.has(id) || [...this.jobs.values()].some(item => item.jobKey === jobKey)) throw new Error('unique constraint');
      this.jobs.set(id, { jobKey, trackingId, status, stage, version, updatedAt, recordJson });
    } else if (sql.startsWith('UPDATE ocpa_job_records')) {
      const jobKey = this.stringBinding(bindings, 0);
      const trackingId = this.stringBinding(bindings, 1);
      const status = this.stringBinding(bindings, 2);
      const stage = this.stringBinding(bindings, 3);
      const version = this.numberBinding(bindings, 4);
      const updatedAt = this.stringBinding(bindings, 5);
      const recordJson = this.stringBinding(bindings, 6);
      const identityColumns = sql.includes('source_from_commit = ?');
      const id = this.stringBinding(bindings, identityColumns ? 11 : 7);
      const expectedVersion = this.numberBinding(bindings, identityColumns ? 12 : 8);
      const current = this.jobs.get(id);
      if (current?.version === expectedVersion) {
        this.jobs.set(id, { jobKey, trackingId, status, stage, version, updatedAt, recordJson });
        rows = [{ id }];
      }
    } else if (sql.includes('SELECT DISTINCT j.tracking_id FROM ocpa_job_records j JOIN ocpa_job_publication_effects')) {
      const hasAfter = sql.includes('j.tracking_id > ?');
      const after = hasAfter ? this.stringBinding(bindings, 1) : undefined;
      const limit = this.numberBinding(bindings, bindings.length - 1);
      const ids = [...new Set([...this.jobs.entries()].filter(([id, job]) => job.status === 'published'
        && this.effects.get(id)?.status === 'published' && job.trackingId !== undefined
        && (!after || job.trackingId > after)).map(([, job]) => job.trackingId))]
        .sort().slice(0, limit);
      rows = ids.map(tracking_id => ({ tracking_id }));
    } else if (sql.includes('SELECT record_json FROM ocpa_job_records WHERE status IN')) {
      const placeholderText = sql.match(/status IN \(([^)]+)\)/)?.[1] ?? '';
      const statusCount = (placeholderText.match(/\?/g) ?? []).length;
      const statusOffset = sql.includes('tracking_id = ?') ? 1 : 0;
      const trackingId = statusOffset ? this.stringBinding(bindings, 0) : undefined;
      const statuses = bindings.slice(statusOffset, statusOffset + statusCount)
        .filter((value): value is string => typeof value === 'string');
      const afterOffset = statusOffset + statusCount;
      const afterId = sql.includes('id > ?') ? this.stringBinding(bindings, afterOffset) : undefined;
      const limit = this.numberBinding(bindings, bindings.length - 1);
      rows = [...this.jobs.entries()].filter(([id, job]) => statuses.includes(job.status)
        && (!trackingId || job.trackingId === trackingId) && (!afterId || id > afterId))
        .sort(([left], [right]) => left.localeCompare(right)).slice(0, limit)
        .map(([, job]) => ({ record_json: job.recordJson }));
    } else if (sql.startsWith('SELECT j.record_json FROM ocpa_job_records j JOIN ocpa_job_publication_effects')) {
      const trackingId = this.stringBinding(bindings, 0);
      const now = this.numberBinding(bindings, 1);
      const hasAfter = sql.includes('j.id > ?');
      const after = hasAfter ? this.stringBinding(bindings, 2) : undefined;
      const limit = this.numberBinding(bindings, bindings.length - 1);
      rows = [...this.jobs.entries()].filter(([id, job]) => {
        const effect = this.effects.get(id);
        return job.trackingId === trackingId && job.status === 'published' && effect?.status === 'published'
          && (effect.nextAttemptAt === null || effect.nextAttemptAt <= now) && (!after || id > after);
      }).sort(([left], [right]) => left.localeCompare(right)).slice(0, limit)
        .map(([, job]) => ({ record_json: job.recordJson }));
    } else if (sql.startsWith('SELECT j.id FROM ocpa_job_records j JOIN ocpa_job_publication_effects')) {
      const trackingId = this.stringBinding(bindings, 0);
      const id = [...this.jobs.entries()].find(([jobId, job]) => job.trackingId === trackingId
        && job.status === 'published' && this.effects.get(jobId)?.status === 'published')?.[0];
      rows = id ? [{ id }] : [];
    } else if (sql.includes("tracking_id = ? AND status = 'published'")) {
      const trackingId = this.stringBinding(bindings, 0);
      const after = sql.includes('id > ?') ? this.stringBinding(bindings, 1) : undefined;
      const limit = this.numberBinding(bindings, bindings.length - 1);
      rows = [...this.jobs.entries()].filter(([id, job]) => job.trackingId === trackingId && job.status === 'published'
        && (!after || id > after)).sort(([left], [right]) => left.localeCompare(right)).slice(0, limit)
        .map(([, job]) => ({ record_json: job.recordJson }));
    } else if (sql.includes('SELECT job_id, attempts, status, claim_token')) {
      const effect = this.effects.get(this.stringBinding(bindings, 0));
      rows = effect ? [{
        job_id: effect.jobId,
        attempts: effect.attempts,
        status: effect.status,
        claim_token: effect.claimToken,
        lease_until: effect.leaseUntil,
        next_attempt_at: effect.nextAttemptAt,
        last_failure_code: effect.lastFailureCode,
        pull_request_number: effect.pullRequestNumber,
        url: effect.url,
        head_commit: effect.headCommit,
        reconciliation_attempts: effect.reconciliationAttempts,
        updated_at: effect.updatedAt,
      }] : [];
    } else if (sql.startsWith('INSERT INTO ocpa_job_publication_effects')) {
      const jobId = this.stringBinding(bindings, 0);
      const attempts = this.numberBinding(bindings, 1);
      const claimToken = this.stringBinding(bindings, 2);
      const leaseUntil = this.numberBinding(bindings, 3);
      const updatedAt = this.stringBinding(bindings, 4);
      const current = this.effects.get(jobId);
      this.effects.set(jobId, {
        jobId, attempts, status: 'publishing', claimToken, leaseUntil, nextAttemptAt: null, lastFailureCode: null,
        reconciliationAttempts: current?.reconciliationAttempts ?? 0,
        pullRequestNumber: current?.pullRequestNumber ?? null,
        url: current?.url ?? null,
        headCommit: current?.headCommit ?? null,
        updatedAt,
      });
    } else if (sql.startsWith('UPDATE ocpa_job_publication_effects SET status = \'published\'')) {
      const pullRequestNumber = this.numberBinding(bindings, 0);
      const url = this.stringBinding(bindings, 1);
      const headCommit = this.stringBinding(bindings, 2);
      const nextAttemptAt = this.numberBinding(bindings, 3);
      const updatedAt = this.stringBinding(bindings, 4);
      const jobId = this.stringBinding(bindings, 5);
      const claimToken = this.stringBinding(bindings, 6);
      const current = this.effects.get(jobId);
      if (current?.claimToken === claimToken) {
        this.effects.set(jobId, {
          ...current, status: 'published', claimToken: null, leaseUntil: null, nextAttemptAt,
          reconciliationAttempts: 0,
          pullRequestNumber, url, headCommit, lastFailureCode: null, updatedAt,
        });
        rows = [{ job_id: jobId }];
      }
    } else if (sql.startsWith("UPDATE ocpa_job_publication_effects SET status = 'retryable'")) {
      const code = this.stringBinding(bindings, 0);
      const nextAttemptAt = this.numberBinding(bindings, 1);
      const updatedAt = this.stringBinding(bindings, 2);
      const jobId = this.stringBinding(bindings, 3);
      const claimToken = this.stringBinding(bindings, 4);
      const current = this.effects.get(jobId);
      if (current?.claimToken === claimToken) {
        this.effects.set(jobId, { ...current, status: 'retryable', claimToken: null, leaseUntil: null, nextAttemptAt, lastFailureCode: code, updatedAt });
        rows = [{ job_id: jobId }];
      }
    } else if (sql.startsWith("UPDATE ocpa_job_publication_effects SET status = 'uncertain'")) {
      const code = this.stringBinding(bindings, 0);
      const updatedAt = this.stringBinding(bindings, 1);
      const jobId = this.stringBinding(bindings, 2);
      const current = this.effects.get(jobId);
      if (current) this.effects.set(jobId, { ...current, status: 'uncertain', claimToken: null, leaseUntil: null, nextAttemptAt: null, lastFailureCode: code, updatedAt });
    } else if (sql.startsWith("UPDATE ocpa_job_publication_effects SET status = 'closed-unmerged'")) {
      const code = this.stringBinding(bindings, 0);
      const updatedAt = this.stringBinding(bindings, 1);
      const jobId = this.stringBinding(bindings, 2);
      const pullRequestNumber = this.numberBinding(bindings, 3);
      const current = this.effects.get(jobId);
      if (current?.status === 'published' && current.pullRequestNumber === pullRequestNumber) {
        this.effects.set(jobId, { ...current, status: 'closed-unmerged', lastFailureCode: code, claimToken: null,
          leaseUntil: null, nextAttemptAt: null, updatedAt });
        rows = [{ job_id: jobId }];
      }
    } else if (sql.startsWith("UPDATE ocpa_job_publication_effects SET status = 'merged'")) {
      const updatedAt = this.stringBinding(bindings, 0);
      const jobId = this.stringBinding(bindings, 1);
      const pullRequestNumber = this.numberBinding(bindings, 2);
      const current = this.effects.get(jobId);
      if (current?.status === 'published' && current.pullRequestNumber === pullRequestNumber) {
        this.effects.set(jobId, { ...current, status: 'merged', nextAttemptAt: null, claimToken: null,
          leaseUntil: null, updatedAt });
        rows = [{ job_id: jobId }];
      }
    } else if (sql.startsWith('UPDATE ocpa_job_publication_effects SET reconciliation_attempts =')) {
      const dueAt = this.numberBinding(bindings, 0);
      const updatedAt = this.stringBinding(bindings, 1);
      const jobId = this.stringBinding(bindings, 2);
      const current = this.effects.get(jobId);
      if (current?.status === 'published') {
        this.effects.set(jobId, { ...current, reconciliationAttempts: current.reconciliationAttempts + 1,
          nextAttemptAt: dueAt, updatedAt });
        rows = [{ job_id: jobId }];
      }
    } else if (sql.startsWith('INSERT INTO ocpa_job_cleanup_requests')) {
      this.cleanupRequests.add(this.stringBinding(bindings, 0));
      rows = [];
    } else if (sql.startsWith('SELECT job_id FROM ocpa_job_cleanup_requests')) {
      const limit = this.numberBinding(bindings, 0);
      rows = [...this.cleanupRequests].slice(0, limit).map(job_id => ({ job_id }));
    } else if (sql.startsWith('DELETE FROM ocpa_job_cleanup_requests')) {
      this.cleanupRequests.delete(this.stringBinding(bindings, 0));
    } else if (sql.startsWith('SELECT after_job_id FROM ocpa_reconcile_cursors')) {
      const cursor = this.reconciliationCursors.get(this.stringBinding(bindings, 0));
      rows = cursor ? [{ after_job_id: cursor }] : [];
    } else if (sql.startsWith('INSERT INTO ocpa_reconcile_cursors')) {
      this.reconciliationCursors.set(this.stringBinding(bindings, 0), this.stringBinding(bindings, 1));
    } else if (sql.startsWith('DELETE FROM ocpa_reconcile_cursors')) {
      this.reconciliationCursors.delete(this.stringBinding(bindings, 0));
    } else if (sql.startsWith('INSERT INTO ocpa_active_run')) {
      this.run = {
        generation_id: this.stringBinding(bindings, 0),
        tracking_id: this.stringBinding(bindings, 1),
        job_id: null,
        status: 'active',
        deadline_at: this.numberBinding(bindings, 2),
        cancel_requested: 0,
        cancel_code: null,
      };
    } else if (sql.startsWith('SELECT generation_id, tracking_id, job_id, status, deadline_at')) {
      rows = this.run ? [{ ...this.run }] : [];
    } else if (sql.startsWith('UPDATE ocpa_active_run SET cancel_requested = 1, cancel_code = ?')) {
      const code = this.stringBinding(bindings, 0);
      const generationId = this.stringBinding(bindings, 1);
      if (this.run?.generation_id === generationId && this.run.status === 'active') {
        this.run.cancel_requested = 1;
        this.run.cancel_code = code;
        rows = [{ id: 1 }];
      }
    } else if (sql.startsWith('UPDATE ocpa_active_run SET job_id = ?')) {
      const jobId = this.stringBinding(bindings, 0);
      const generationId = this.stringBinding(bindings, 1);
      if (this.run?.generation_id === generationId && this.run.status === 'active' && !this.run.cancel_requested) {
        this.run.job_id = jobId;
        rows = [{ id: 1 }];
      }
    } else if (sql.startsWith('UPDATE ocpa_active_run SET status =')) {
      const status = this.stringBinding(bindings, 0);
      const generationId = this.stringBinding(bindings, bindings.length - 1);
      if (this.run?.generation_id === generationId && this.run.status === 'active') {
        this.run.status = status;
        rows = [{ id: 1 }];
      }
    } else {
      throw new Error(`Unexpected test SQL: ${sql}`);
    }

    return {
      columnNames: rows.length > 0 ? Object.keys(rows[0]!) : [],
      raw: () => [][Symbol.iterator](),
      toArray: () => rows,
    };
  }

  private stringBinding(bindings: unknown[], index: number): string {
    const value = bindings[index];
    if (typeof value !== 'string') throw new Error(`Expected text binding at ${index}`);
    return value;
  }

  private numberBinding(bindings: unknown[], index: number): number {
    const value = bindings[index];
    if (typeof value !== 'number') throw new Error(`Expected numeric binding at ${index}`);
    return value;
  }
}

function newJob(): NewJobRecord {
  return { id: 'job-1', key: 'job-1', trackingId: plan.trackingId, plan, stepsUsed: 0 };
}

function registration(overrides: Partial<TrackingRegistration> = {}): TrackingRegistration {
  return {
    id: plan.trackingId,
    installationId: plan.installationId,
    target: plan.target,
    baseBranch: plan.baseBranch,
    upstream: { repository: plan.upstreamRepository, ref: plan.upstreamRef, baselineCommit: plan.fromCommit },
    policy: {},
    policyHash: plan.policyHash,
    lastCheckedCommit: plan.fromCommit,
    lastSyncedCommit: plan.fromCommit,
    active: true,
    revision: 1,
    ...overrides,
  };
}

class LifecycleStore implements StorePort {
  readonly jobs = new Map<string, JobRecord>();
  onSave?: (job: JobRecord, expectedVersion: number) => Promise<void>;

  constructor(readonly current: TrackingRegistration) {}
  async createTrackingRegistration(): Promise<TrackingRegistration> { throw new Error('unused'); }
  async getTrackingRegistration(id: string) { return id === this.current.id ? this.current : undefined; }
  async listActiveTrackingRegistrations() { return { registrations: [this.current] }; }
  async setTrackingRegistrationActive(): Promise<boolean> { return false; }
  async recordWebhookDelivery(): Promise<boolean> { return false; }
  async createOrGetJob(input: NewJobRecord): Promise<{ job: JobRecord; created: boolean }> {
    const existing = this.jobs.get(input.id);
    if (existing) return { job: existing, created: false };
    const job: JobRecord = { ...input, status: 'queued', stage: 'queued', version: 0, attempt: 0,
      createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }
  async getJob(id: string) { return this.jobs.get(id); }
  async getJobByKey(key: string) { return [...this.jobs.values()].find(job => job.key === key); }
  async listJobsForCumulativeRange(_input: Parameters<StorePort['listJobsForCumulativeRange']>[0])
    : Promise<Awaited<ReturnType<StorePort['listJobsForCumulativeRange']>>> { return { jobs: [], more: false }; }
  async listJobsForSyncOrigin(_input: Parameters<StorePort['listJobsForSyncOrigin']>[0])
    : Promise<Awaited<ReturnType<StorePort['listJobsForSyncOrigin']>>> { return { jobs: [], more: false }; }
  async saveJob(job: JobRecord, expectedVersion: number) {
    if (this.jobs.get(job.id)?.version !== expectedVersion) throw new Error('job compare-and-swap failed');
    await this.onSave?.(job, expectedVersion);
    this.jobs.set(job.id, job);
    return job;
  }
  async advanceLastCheckedCommit(_input: Parameters<StorePort['advanceLastCheckedCommit']>[0]): Promise<boolean> { return false; }
  async activateLastSyncedCommit(input: SyncedCommitActivation): Promise<boolean> {
    if (this.current.lastSyncedCommit !== input.expectedLastSyncedCommit
      || input.candidate.expectedLastSyncedCommit !== input.expectedLastSyncedCommit
      || input.merge.jobId !== input.candidate.jobId) return false;
    this.current.lastSyncedCommit = input.candidate.upstreamCommit;
    return true;
  }
}

class NativeSqlite implements SqlStoragePort {
  constructor(private readonly database: DatabaseSync) {}

  exec(query: string, ...bindings: unknown[]) {
    const sql = query.trim();
    const values = bindings.map(value => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value;
      throw new Error('unsupported SQLite test binding');
    });
    let rows: Record<string, string | number | null | ArrayBuffer>[] = [];
    if (/^(CREATE|ALTER|DROP)\b/i.test(sql)) this.database.exec(query);
    else if (/^(SELECT|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      rows = this.database.prepare(sql).all(...values) as unknown as Record<string, string | number | null | ArrayBuffer>[];
    } else this.database.prepare(sql).run(...values);
    return {
      columnNames: rows.length > 0 ? Object.keys(rows[0]!) : [],
      raw: () => [][Symbol.iterator](),
      toArray: () => rows,
    };
  }
}

class NativeDurableStorage implements DurableJobSqlPort {
  readonly sql: SqlStoragePort;
  constructor(private readonly database: DatabaseSync) { this.sql = new NativeSqlite(database); }
  transactionSync<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class SQLiteGenerationStore extends LifecycleStore {
  constructor(registrationRecord: TrackingRegistration, private readonly durable: DurableSqliteJobStore) {
    super(registrationRecord);
  }
  override async createOrGetJob(input: NewJobRecord) {
    const created = await this.durable.createOrGetJob(input);
    this.jobs.set(created.job.id, created.job);
    return created;
  }
  override async getJob(id: string) {
    const job = await this.durable.getJob(id);
    if (job) this.jobs.set(job.id, job);
    return job;
  }
  override async getJobByKey(key: string) {
    const job = await this.durable.getJobByKey(key);
    if (job) this.jobs.set(job.id, job);
    return job;
  }
  override listJobsForCumulativeRange(input: Parameters<StorePort['listJobsForCumulativeRange']>[0]) {
    return this.durable.listJobsForCumulativeRange(input);
  }
  override listJobsForSyncOrigin(input: Parameters<StorePort['listJobsForSyncOrigin']>[0]) {
    return this.durable.listJobsForSyncOrigin(input);
  }
  override async saveJob(job: JobRecord, expectedVersion: number) {
    const saved = await this.durable.saveJob(job, expectedVersion);
    this.jobs.set(saved.id, saved);
    return saved;
  }
  override async advanceLastCheckedCommit(input: Parameters<StorePort['advanceLastCheckedCommit']>[0]) {
    if (this.current.lastCheckedCommit === input.nextLastCheckedCommit) return true;
    if (this.current.lastCheckedCommit !== input.expectedLastCheckedCommit || this.current.policyHash !== input.policyHash) return false;
    this.current.lastCheckedCommit = input.nextLastCheckedCommit;
    return true;
  }
}

function originPlan(
  registrationRecord: TrackingRegistration,
  head: string,
  targetBase: string,
  checkedChanges: string[],
): DiscoveredPlan {
  const changedFiles = [
    { path: 'src/parser.ts', status: 'modified' as const },
    { path: 'README.md', status: 'modified' as const },
  ];
  return {
    trackingId: registrationRecord.id,
    installationId: registrationRecord.installationId,
    target: registrationRecord.target,
    baseBranch: registrationRecord.baseBranch,
    targetBaseCommit: targetBase,
    upstreamRepository: registrationRecord.upstream.repository,
    upstreamRef: registrationRecord.upstream.ref,
    fromCommit: registrationRecord.lastSyncedCommit,
    expectedLastCheckedCommit: registrationRecord.lastCheckedCommit,
    toCommit: head,
    commitCount: 1,
    changedFiles,
    changedPaths: changedFiles.map(file => file.path),
    checkedChangedPaths: checkedChanges,
    observedAt: timestamp,
  };
}

class OriginLedgerGitHub implements GitHubPort {
  plan!: DiscoveredPlan;
  private readonly beforeContent = 'export const parse = false;\n';
  private readonly afterContent = 'export const parse = true;\n';

  async verifyTrackingAccess() { return { targetAccessible: true, targetWritable: true, upstreamReadable: true }; }
  async discoverPlan() { return this.plan; }
  async readSourceSnapshot(input: Parameters<GitHubPort['readSourceSnapshot']>[0]): Promise<SourceSnapshot> {
    return { repository: input.plan.upstreamRepository, beforeCommit: input.plan.fromCommit,
      beforeFiles: [{ path: 'src/parser.ts', content: this.beforeContent, sizeBytes: Buffer.byteLength(this.beforeContent), mode: '100644' }],
      commit: input.plan.toCommit,
      files: [{ path: 'src/parser.ts', content: this.afterContent, sizeBytes: Buffer.byteLength(this.afterContent), mode: '100644' }],
      deletedPaths: [] };
  }
  async readTargetSnapshot(input: Parameters<GitHubPort['readTargetSnapshot']>[0]): Promise<TargetSnapshot> {
    const content = 'export const parse = false;\n';
    const file = { path: 'lib/parser.ts', content, sizeBytes: Buffer.byteLength(content), mode: '100644' as const };
    return { repository: input.plan.target, baseBranch: input.plan.baseBranch,
      commit: input.plan.targetBaseCommit, existingPaths: [file.path], files: [file] };
  }
  async readVerificationWorkspace(input: Parameters<GitHubPort['readVerificationWorkspace']>[0]): Promise<VerificationWorkspaceSnapshot> {
    const target = await this.readTargetSnapshot({ plan: input.plan, pathPatterns: ['lib/**'], excludedPathPatterns: [],
      maxFiles: 10, maxFileBytes: 1_000, maxBytes: 10_000, maxJobSeconds: 60 });
    return { complete: true, ...target };
  }
  async publishDraft(): Promise<never> { throw new Error('unused'); }
  async confirmMergedCheckpoint() { return undefined; }
  async getPullRequestLifecycle(): Promise<PullRequestLifecycle> { return { status: 'unknown' }; }
}

class GenerationGitHub implements GitHubPort {
  plan!: DiscoveredPlan;
  private readonly beforeContent = 'export const parse = false;\n';
  private readonly afterContent = 'export const parse = true;\n';

  async verifyTrackingAccess() { return { targetAccessible: true, targetWritable: true, upstreamReadable: true }; }
  async discoverPlan(): Promise<DiscoveredPlan> { return this.plan; }
  async readSourceSnapshot(input: Parameters<GitHubPort['readSourceSnapshot']>[0]): Promise<SourceSnapshot> {
    return {
      repository: input.plan.upstreamRepository,
      beforeCommit: input.plan.fromCommit,
      beforeFiles: [{ path: 'src/parser.ts', content: this.beforeContent, sizeBytes: Buffer.byteLength(this.beforeContent), mode: '100644' }],
      commit: input.plan.toCommit,
      files: [{ path: 'src/parser.ts', content: this.afterContent, sizeBytes: Buffer.byteLength(this.afterContent), mode: '100644' }],
      deletedPaths: [],
    };
  }
  async readTargetSnapshot(input: Parameters<GitHubPort['readTargetSnapshot']>[0]): Promise<TargetSnapshot> {
    const content = 'export const parse = false;\n';
    const file = { path: 'lib/parser.ts', content, sizeBytes: Buffer.byteLength(content), mode: '100644' as const };
    return { repository: input.plan.target, baseBranch: input.plan.baseBranch, commit: input.plan.targetBaseCommit,
      existingPaths: [file.path], files: [file] };
  }
  async readVerificationWorkspace(input: Parameters<GitHubPort['readVerificationWorkspace']>[0]): Promise<VerificationWorkspaceSnapshot> {
    const target = await this.readTargetSnapshot({ plan: input.plan, pathPatterns: ['lib/**'], excludedPathPatterns: [],
      maxFiles: 10, maxFileBytes: 1_000, maxBytes: 10_000, maxJobSeconds: 60 });
    return { complete: true, ...target };
  }
  async publishDraft(): Promise<never> { throw new Error('unused'); }
  async confirmMergedCheckpoint(): Promise<VerifiedMergeObservation | undefined> { return undefined; }
  async getPullRequestLifecycle(): Promise<PullRequestLifecycle> { return { status: 'unknown' }; }
}

async function publishedLifecycleFixture() {
  const sql = new FakeSqlite();
  const durable = new DurableSqliteJobStore({ sql, transactionSync: <T>(callback: () => T): T => callback() });
  durable.initialize();
  const registrationRecord = registration();
  const store = new LifecycleStore(registrationRecord);
  store.onSave = async (job, expectedVersion) => { await durable.saveJob(job, expectedVersion); };
  const created = await durable.createOrGetJob(newJob());
  const candidate: CheckpointCandidate = {
    trackingId: plan.trackingId,
    jobId: plan.jobId,
    jobKey: plan.jobKey,
    upstreamCommit: plan.toCommit,
    targetBaseCommit: plan.targetBaseCommit,
    policyHash: plan.policyHash,
    expectedLastCheckedCommit: plan.expectedLastCheckedCommit,
    expectedLastSyncedCommit: registrationRecord.lastSyncedCommit,
  };
  const verification: VerificationResult = {
    status: 'passed',
    steps: [{ index: 0, exitCode: 0, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 }],
    workspaceFiles: [{ path: 'lib/parser.ts', operation: 'write', sha256: 'e'.repeat(64), mode: '100644' }],
  };
  const proposal = {
    report: { summary: 'updated', decisions: [{ selection: 'parser', status: 'applied' as const, reason: 'changed' }] },
    edits: [{ path: 'lib/parser.ts', operation: 'write' as const, content: 'export const parse = true;\n' }],
    verification,
    checkpointCandidate: candidate,
  };
  const ready: JobRecord = { ...created.job, status: 'ready-to-publish', stage: 'ready-to-publish', version: 1,
    proposal, updatedAt: timestamp };
  await durable.saveJob(ready, created.job.version);
  const claim = durable.claimPublication(ready.id, Date.now(), 10_000);
  if (claim.kind !== 'claimed') throw new Error('expected publication claim');
  const publication = { pullRequestNumber: 17, url: 'https://github.com/org/target/pull/17', headCommit: 'f'.repeat(40) };
  const published = durable.completePublication(ready, claim.claimToken, publication);
  store.jobs.set(published.id, published);

  let lifecycle: PullRequestLifecycle = { status: 'open', pullRequestNumber: publication.pullRequestNumber, observedAt: timestamp };
  const github: GitHubPort = {
    async verifyTrackingAccess() { return { targetAccessible: true, targetWritable: true, upstreamReadable: true }; },
    async discoverPlan() { return undefined; },
    async readSourceSnapshot() { throw new Error('unused'); },
    async readTargetSnapshot() { throw new Error('unused'); },
    async readVerificationWorkspace() { throw new Error('unused'); },
    async publishDraft() { return publication; },
    async confirmMergedCheckpoint() { return undefined; },
    async getPullRequestLifecycle() { return lifecycle; },
  };
  const instance = Object.create(TargetJobDO.prototype) as TargetJobDO;
  Reflect.set(instance, 'durableJobs', durable);
  Reflect.set(instance, 'store', store);
  Reflect.set(instance, 'github', github);
  const invoke = async (): Promise<unknown> => {
    const method: unknown = Reflect.get(TargetJobDO.prototype, 'activateMergedJobs');
    if (typeof method !== 'function') throw new Error('DO lifecycle method is unavailable');
    return Reflect.apply(method, instance, [registrationRecord.id, { controller: new AbortController(), deadlineAt: Date.now() + 30_000 }]);
  };
  return { sql, durable, registration: registrationRecord, store, candidate, publication, setLifecycle: (value: PullRequestLifecycle) => { lifecycle = value; }, invoke };
}

describe('target job durable storage and routing', () => {
  let sql: FakeSqlite;
  let store: DurableSqliteJobStore;

  beforeEach(() => {
    sql = new FakeSqlite();
    store = new DurableSqliteJobStore({ sql, transactionSync: <T>(callback: () => T): T => callback() });
    store.initialize();
  });

  it('pairs the trusted provider selection with only its own key and never falls back', () => {
    const consoleProvider = resolveHostedProviderEnvironment({
      OPENCODE_PROVIDER: 'opencode',
      OPENCODE_API_KEY: 'synthetic-console-key',
      OPENAI_API_KEY: 'synthetic-openai-key',
      OPENCODE_MODEL: 'gpt-6-luna',
    });
    expect(consoleProvider).toMatchObject({
      provider: 'opencode',
      providerID: 'ocpa-opencode',
      apiKey: 'synthetic-console-key',
      model: 'gpt-6-luna',
      protocol: 'responses',
      baseURL: 'https://opencode.ai/zen/v1',
    });

    expect(() => resolveHostedProviderEnvironment({
      OPENCODE_PROVIDER: 'opencode',
      OPENCODE_API_KEY: '',
      OPENAI_API_KEY: 'synthetic-openai-key',
      OPENCODE_MODEL: 'gpt-6-luna',
    })).toThrowError('agent-provider-credential-missing');

    const legacyProvider = resolveHostedProviderEnvironment({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_API_KEY: 'synthetic-console-key',
      OPENAI_API_KEY: 'synthetic-openai-key',
      OPENCODE_MODEL: 'gpt-4.1-mini',
    });
    expect(legacyProvider).toMatchObject({
      provider: 'openai',
      providerID: 'ocpa-openai',
      apiKey: 'synthetic-openai-key',
      model: 'gpt-4.1-mini',
      protocol: 'chat-completions',
      baseURL: 'https://api.openai.com/v1',
    });
  });

  it('creates different target hosts from the same service bindings and consumes rotated bindings on replacement', async () => {
    const factory = vi.mocked(createOpenCodeAgent);
    factory.mockResolvedValue({ close: async () => {} } as Awaited<ReturnType<typeof createOpenCodeAgent>>);
    const serviceBindings = {
      OPENCODE_PROVIDER: 'opencode', OPENCODE_MODEL: 'gpt-6-luna',
      OPENCODE_API_KEY: 'synthetic-service-key', OPENAI_API_KEY: 'synthetic-unused-key',
      GITHUB_APP_ID: '8', GITHUB_PRIVATE_KEY: 'synthetic-private-key',
      DB: {}, SANDBOX: {},
    } as TargetJobEnvironment;
    const records = [registration(), registration({
      id: 'tracking-2', target: { owner: 'org', name: 'second', fullName: 'org/second' },
    })];
    const before = JSON.stringify(records);
    const databases: DatabaseSync[] = [];
    const startHost = async (record: TrackingRegistration, env: TargetJobEnvironment) => {
      const database = new DatabaseSync(':memory:');
      databases.push(database);
      let initialization: Promise<void> | undefined;
      const context = {
        storage: new NativeDurableStorage(database),
        blockConcurrencyWhile(callback: () => Promise<void>) { initialization = callback(); return initialization; },
      } as unknown as ConstructorParameters<typeof TargetJobDO>[0];
      new TargetJobDO(context, env);
      await initialization;
      const durable = new DurableSqliteJobStore(context.storage);
      durable.bindTargetIdentity(await jobInstanceName(record));
    };
    try {
      expect(await jobInstanceName(records[0]!)).not.toBe(await jobInstanceName(records[1]!));
      await startHost(records[0]!, { ...serviceBindings });
      await startHost(records[1]!, { ...serviceBindings });
      await startHost(records[0]!, { ...serviceBindings, OPENCODE_API_KEY: 'synthetic-rotated-key' });
      expect(factory.mock.calls.map(([options]) => options.provider)).toEqual([
        expect.objectContaining({ provider: 'opencode', apiKey: 'synthetic-service-key', model: 'gpt-6-luna' }),
        expect.objectContaining({ provider: 'opencode', apiKey: 'synthetic-service-key', model: 'gpt-6-luna' }),
        expect.objectContaining({ provider: 'opencode', apiKey: 'synthetic-rotated-key', model: 'gpt-6-luna' }),
      ]);
      expect(JSON.stringify(records)).toBe(before);
      for (const database of databases) {
        const dump = JSON.stringify(database.prepare('SELECT * FROM ocpa_job_target_identity').all());
        expect(dump).not.toContain('synthetic-');
        expect(database.prepare('SELECT COUNT(*) AS count FROM ocpa_job_records').get()).toEqual({ count: 0 });
      }
    } finally {
      factory.mockReset();
      databases.forEach(database => database.close());
    }
  });

  it('rejects invalid selected credentials before creating production target dependencies without fallback', async () => {
    const factory = vi.mocked(createOpenCodeAgent);
    for (const key of [undefined, '', ' ', 'synthetic key', 'synthetic\nkey', 'synthetic\u007fkey']) {
      const instance = Object.create(TargetJobDO.prototype) as TargetJobDO;
      Reflect.set(instance, 'ctx', { storage: {} });
      Reflect.set(instance, 'env', {
        OPENCODE_PROVIDER: 'openai', OPENCODE_MODEL: 'gpt-4.1-mini',
        OPENCODE_API_KEY: 'synthetic-unselected-key', OPENAI_API_KEY: key,
      });
      const createHost: unknown = Reflect.get(TargetJobDO.prototype, 'createAgentHost');
      if (typeof createHost !== 'function') throw new Error('missing production host factory');
      await expect(Reflect.apply(createHost, instance, [])).rejects.toThrow('agent-provider-credential-missing');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('creates one durable job by deterministic key and rejects conflicting IDs', async () => {
    const created = await store.createOrGetJob(newJob());
    expect(created.created).toBe(true);
    expect(created.job.status).toBe('queued');
    const duplicate = await store.createOrGetJob(newJob());
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe('job-1');

    await expect(store.createOrGetJob({ ...newJob(), key: 'other-job' })).rejects.toThrow(TargetJobError);
  });

  it('uses compare-and-swap versions and lists durable recovery candidates', async () => {
    const { job } = await store.createOrGetJob(newJob());
    const running: JobRecord = { ...job, status: 'running', stage: 'agent', version: 1, updatedAt: timestamp };
    await store.saveJob(running, 0);
    await expect(store.saveJob({ ...running, status: 'failed', stage: 'terminal', version: 1 }, 0))
      .rejects.toThrow(TargetJobError);
    expect(store.listByStatuses(['running']).map(item => item.id)).toEqual(['job-1']);
    expect((await store.getJob('job-1'))?.version).toBe(1);
  });

  it('atomically records terminal state with a durable job-owned cleanup request', async () => {
    const { job } = await store.createOrGetJob(newJob());
    const running: JobRecord = { ...job, status: 'running', stage: 'verifying', version: 1, updatedAt: timestamp };
    await store.saveJob(running, job.version);
    const terminal = store.markJobTerminalWithCleanup(running, 'failed', 'runner-cleanup-failed');

    expect(terminal.status).toBe('failed');
    expect(store.pendingSandboxCleanup()).toContain('job-1');
    expect(sql.cleanupRequests).toContain('job-1');
    store.completeSandboxCleanup('job-1');
    expect(store.pendingSandboxCleanup()).toEqual([]);
  });

  it('persists cancellation intent before allowing later job admission', async () => {
    store.beginRun('generation-1', plan.trackingId, Date.now() + 10_000);
    expect(store.setRunJobId('generation-1', 'job-1')).toBe(true);
    const cancelled = store.requestRunCancellation(plan.trackingId, 'operator-cancelled');
    expect(cancelled).toMatchObject({ generationId: 'generation-1', jobId: 'job-1', cancelRequested: true });
    expect(store.setRunJobId('generation-1', 'late-job')).toBe(false);
    expect(store.runState()).toMatchObject({ status: 'active', cancelRequested: true, cancelCode: 'operator-cancelled' });
    store.finishRun('generation-1', 'cancelled', 'operator-cancelled');
    store.beginRun('generation-2', plan.trackingId, Date.now() + 10_000);
    store.requestRunCancellation(plan.trackingId, 'operator-cancelled');
    expect(() => store.createOrGetJobForRun('generation-2', {
      ...newJob(),
      id: 'late-job',
      key: 'late-job',
      plan: { ...plan, jobId: 'late-job', jobKey: 'late-job' },
    })).toThrow(TargetJobError);
    expect(await store.getJob('late-job')).toBeUndefined();
  });

  it('returns bounded keyset pages for retained published jobs instead of rejecting their count', async () => {
    for (let index = 0; index < 40; index++) {
      const id = `job-${String(index).padStart(2, '0')}`;
      const jobPlan = { ...plan, jobId: id, jobKey: id };
      const { job } = await store.createOrGetJob({ id, key: id, trackingId: plan.trackingId, plan: jobPlan, stepsUsed: 0 });
      const claim = store.claimPublication(id, Date.now(), 1_000);
      if (claim.kind !== 'claimed') throw new Error('expected publication claim');
      store.completePublication(job, claim.claimToken, {
        pullRequestNumber: index + 1,
        url: `https://github.com/org/target/pull/${index + 1}`,
        headCommit: 'e'.repeat(40),
      });
    }
    const first = store.listPublishedForTrackingPage(plan.trackingId, undefined, 16);
    const second = store.listPublishedForTrackingPage(plan.trackingId, first.lastJobId, 16);
    const third = store.listPublishedForTrackingPage(plan.trackingId, second.lastJobId, 16);

    expect(first.jobs).toHaveLength(16);
    expect(second.jobs).toHaveLength(16);
    expect(third.jobs).toHaveLength(8);
    expect(new Set([...first.jobs, ...second.jobs, ...third.jobs].map(job => job.id)).size).toBe(40);
  });

  it('turns evicted in-progress work into a terminal failure rather than repeating the model call', async () => {
    const { job } = await store.createOrGetJob(newJob());
    const running: JobRecord = { ...job, status: 'running', stage: 'agent', attempt: 1, version: 1, updatedAt: timestamp };
    await store.saveJob(running, 0);
    const failed = markInterruptedJobFailed(running, timestamp);
    await store.saveJob(failed, running.version);
    expect((await store.getJob('job-1'))).toMatchObject({
      status: 'failed',
      stage: 'terminal',
      failure: { code: 'stale-in-progress-job' },
      version: 2,
    });
    expect(store.listByStatuses(['queued', 'running'])).toHaveLength(0);
    expect(() => markInterruptedJobFailed(failed, timestamp)).toThrow(TargetJobError);
  });

  it('persists publication claims and enforces durable retry backoff', () => {
    const now = Date.now();
    const concurrent = [
      Promise.resolve().then(() => store.claimPublication('job-1', now, 1_000)),
      Promise.resolve().then(() => store.claimPublication('job-1', now, 1_000)),
    ];
    const claims = Promise.all(concurrent);
    return claims.then(firstClaims => {
      expect(firstClaims.filter(claim => claim.kind === 'claimed')).toHaveLength(1);
      expect(firstClaims.filter(claim => claim.kind === 'deferred')).toHaveLength(1);
      const first = firstClaims.find(claim => claim.kind === 'claimed');
      expect(first).toBeDefined();
      if (!first || first.kind !== 'claimed') throw new Error('expected publication claim');
      const dueAt = now + 2_000;
      expect(store.markPublicationRetryable('job-1', first.claimToken, 'network-timeout', dueAt)).toBe(true);
      expect(store.claimPublication('job-1', dueAt - 1, 1_000)).toMatchObject({ kind: 'deferred', dueAt });
      const second = store.claimPublication('job-1', dueAt, 1_000);
      expect(second.kind).toBe('claimed');
      if (second.kind !== 'claimed') throw new Error('expected second publication claim');
      expect(store.markPublicationComplete('job-1', second.claimToken, {
        pullRequestNumber: 5,
        url: 'https://github.com/org/target/pull/5',
        headCommit: 'e'.repeat(40),
      })).toBe(true);
      expect(store.publicationEffect('job-1')).toMatchObject({
        attempts: 2,
        status: 'published',
        pullRequestNumber: 5,
        headCommit: 'e'.repeat(40),
      });
      expect(store.claimPublication('job-1', dueAt + 1, 1_000)).toMatchObject({ kind: 'published' });
    });
  });

  it('retains closed-unmerged evidence as terminal cancellation and uses durable lifecycle backoff', async () => {
    const { job } = await store.createOrGetJob(newJob());
    const claim = store.claimPublication(job.id, Date.now(), 1_000);
    if (claim.kind !== 'claimed') throw new Error('expected publication claim');
    const published = store.completePublication(job, claim.claimToken, {
      pullRequestNumber: 91,
      url: 'https://github.com/org/target/pull/91',
      headCommit: 'e'.repeat(40),
    });
    const dueAt = store.scheduleLifecycleRecheck(job.id, Date.now(), 17);
    expect(dueAt).toBeGreaterThan(Date.now());
    expect(store.listPublishedForTrackingPage(plan.trackingId, undefined, 4).jobs).toHaveLength(0);
    expect(store.hasPublishedLifecycleJobs(plan.trackingId)).toBe(true);
    expect(store.publicationEffect(job.id)?.reconciliationAttempts).toBe(1);

    const cancelled = store.markClosedUnmerged(published, 91);
    expect(cancelled).toMatchObject({ status: 'cancelled', failure: { code: 'pull-request-closed-unmerged' } });
    expect(store.publicationEffect(job.id)).toMatchObject({
      status: 'closed-unmerged', pullRequestNumber: 91, lastFailureCode: 'pull-request-closed-unmerged',
    });
    expect(store.listPublishedForTrackingPage(plan.trackingId, undefined, 4).jobs).toHaveLength(0);
    expect(store.hasPublishedLifecycleJobs(plan.trackingId)).toBe(false);
  });

  it('reconciles real DO lifecycle gates without activating open/closed PRs and activates only merged observations', async () => {
    const closed = await publishedLifecycleFixture();
    expect(await closed.invoke()).toBe(true);
    expect(closed.registration.lastSyncedCommit).toBe(plan.fromCommit);
    expect(closed.durable.publicationEffect('job-1')).toMatchObject({ status: 'published', reconciliationAttempts: 1 });
    const closedEffect = closed.durable.publicationEffect('job-1');
    if (closedEffect) closed.sql.effects.get('job-1')!.nextAttemptAt = null;
    closed.setLifecycle({ status: 'closed-unmerged', pullRequestNumber: closed.publication.pullRequestNumber, observedAt: timestamp });
    expect(await closed.invoke()).toBe(false);
    expect((await closed.durable.getJob('job-1'))).toMatchObject({ status: 'cancelled', failure: { code: 'pull-request-closed-unmerged' } });
    expect(closed.registration.lastSyncedCommit).toBe(plan.fromCommit);
    expect(closed.durable.publicationEffect('job-1')?.status).toBe('closed-unmerged');

    const merged = await publishedLifecycleFixture();
    const observation: VerifiedMergeObservation = {
      trackingId: plan.trackingId,
      jobId: plan.jobId,
      pullRequestNumber: merged.publication.pullRequestNumber,
      baseBranch: 'main',
      upstreamCommit: plan.toCommit,
      targetBaseCommit: plan.targetBaseCommit,
      observedBaseCommit: '9'.repeat(40),
      mergeCommit: '8'.repeat(40),
      observedAt: timestamp,
    };
    merged.setLifecycle({ status: 'merged', observation });
    expect(await merged.invoke()).toBe(false);
    expect(merged.registration.lastSyncedCommit).toBe(plan.toCommit);
    expect((await merged.durable.getJob('job-1'))?.status).toBe('merged');
    expect(merged.durable.publicationEffect('job-1')?.status).toBe('merged');
  });

  it('enforces a synchronized-origin generation cap in the production SQLite job ledger across irrelevant heads', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      const durable = new DurableSqliteJobStore(new NativeDurableStorage(database));
      durable.initialize();
      const origin = 'a'.repeat(40);
      const policy = parsePolicy({
        version: 1,
        upstream: { repository: plan.upstreamRepository, ref: 'main' },
        selections: [{
          id: 'parser', description: 'Port parser behavior.', upstreamPaths: ['src/**'], excludeUpstreamPaths: [],
          targetPaths: ['lib/**'], acceptance: ['Keep the parser contract.'],
          mappings: [{ upstream: 'src/parser.ts', target: ['lib/parser.ts'] }],
        }],
        preserve: [], verification: [{ command: 'node', args: ['test.js'], timeoutSeconds: 10 }], limits: { ...DEFAULT_LIMITS },
      });
      const digest = await policyHash(policy);
      const activeRegistration = registration({
        upstream: { repository: policy.upstream.repository, ref: policy.upstream.ref, baselineCommit: origin },
        policy,
        policyHash: digest,
        lastCheckedCommit: origin,
        lastSyncedCommit: origin,
      });
      const store = new SQLiteGenerationStore(activeRegistration, durable);
      const github = new OriginLedgerGitHub();
      const agent: AgentPort & { calls: number } = {
        calls: 0,
        async run() {
          this.calls++;
          return {
            report: { summary: 'Port parser.', decisions: [{ selection: 'parser', status: 'applied', reason: 'Parser selected.' }] },
            edits: [{ path: 'lib/parser.ts', operation: 'write', content: 'export const parse = true;\n' }],
            stepsUsed: 1,
            durationMs: 1,
          };
        },
      };
      const runner: RunnerPort & { calls: number } = {
        calls: 0,
        async verify(request: RunnerRequest): Promise<VerificationResult> {
          this.calls++;
          const content = request.edits[0]?.content ?? '';
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
          return {
            status: 'passed',
            steps: [{ index: 0, exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 }],
            workspaceFiles: [{ path: 'lib/parser.ts', operation: 'write',
              sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''), mode: '100644' }],
          };
        },
      };
      const ports: CorePorts = { store, github, agent, runner, now: () => timestamp };
      const baseCommits = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)];
      const targetBases = ['f'.repeat(40), '1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
      const outcomes = [];
      for (let index = 0; index < baseCommits.length; index++) {
        github.plan = originPlan(activeRegistration, baseCommits[index]!, targetBases[index]!,
          index === 0 ? ['src/parser.ts'] : ['README.md']);
        outcomes.push(await runJob(activeRegistration.id, ports));
      }

      expect(outcomes.slice(0, 2).map(result => result.status)).toEqual(['ready-to-publish', 'ready-to-publish']);
      expect(outcomes.slice(2).map(result => result.status)).toEqual(['failed', 'failed']);
      expect(outcomes[2]).toMatchObject({ status: 'failed', job: { failure: { code: 'sync-origin-generation-limit' } } });
      expect(outcomes[3]).toMatchObject({ status: 'failed', job: { failure: { code: 'sync-origin-generation-limit' } } });
      expect(agent.calls).toBe(2);
      expect(runner.calls).toBe(2);
      expect(activeRegistration.lastSyncedCommit).toBe(origin);
      expect(activeRegistration.lastCheckedCommit).toBe(baseCommits[1]);
      const history = await durable.listJobsForSyncOrigin({
        trackingId: activeRegistration.id, fromCommit: origin, policyHash: digest, limit: 10,
      });
      expect(history.more).toBe(false);
      expect(history.jobs).toHaveLength(3);
      expect(history.jobs.filter(job => job.failure?.code === 'sync-origin-generation-limit')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('binds one DO database to one installation/target/base identity', async () => {
    const name = await jobInstanceName(registration());
    expect(name).toMatch(/^target-[a-f0-9]{64}$/);
    expect(await jobInstanceName(registration())).toBe(name);
    expect(await jobInstanceName(registration({ baseBranch: 'release' }))).not.toBe(name);
    expect(await jobInstanceName(registration({ installationId: 9 }))).not.toBe(name);

    store.bindTargetIdentity('first');
    expect(() => store.bindTargetIdentity('first')).not.toThrow();
    expect(() => store.bindTargetIdentity('different')).toThrow(TargetJobError);
  });
});
