import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentOutput,
  AgentPort,
  AgentRequest,
  CheckpointCandidate,
  DraftPublication,
  DraftPublicationRequest,
  GitHubPort,
  JobRecord,
  NewJobRecord,
  PullRequestLifecycle,
  RepositoryIdentity,
  RunnerPort,
  RunnerRequest,
  SnapshotFile,
  SourceSnapshot,
  StorePort,
  SyncedCommitActivation,
  TargetSnapshot,
  TrackingRegistration,
  VerificationResult,
  VerifiedMergeObservation,
  VerificationWorkspaceSnapshot,
} from '../src/contracts.js';
import { activateMergedCheckpoint, runJob } from '../src/core.js';
import { DEFAULT_LIMITS, parsePolicy, policyHash } from '../src/policy.js';
import { D1RegistryStore, type D1DatabaseBinding, type D1PreparedStatementBinding, type D1QueryResult, type D1SqlValue, type QueueWorkMessage } from '../src/store.js';
import { createWorker, type WorkerDependencies } from '../src/worker.js';
import type { Env, QueueBatchBinding, QueueMessageBinding, TargetJobRpc } from '../src/env.js';

const execFileAsync = promisify(execFile);
const repository: RepositoryIdentity = { owner: 'fixture-org', name: 'bom-target', fullName: 'fixture-org/bom-target' };
const upstreamRepository = 'https://github.com/fixture-org/bom-upstream.git';
const baselineCommit = 'a'.repeat(40);
const upstreamHead = 'b'.repeat(40);
const targetBaseCommit = 'c'.repeat(40);
const timestamp = '2026-10-10T12:00:00.000Z';
const adminToken = 'offline-integration-admin-token';
const helperContent = `export function assertString(actual, expected) {
  if (actual !== expected) throw new Error('assertion mismatch: ' + JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
`;

const fixedPackageJson = JSON.stringify({ type: 'module', scripts: { test: 'node --test test/strip-prefix.test.mjs' } }, null, 2) + '\n';
const fixedTest = `import test from 'node:test';
import { stripPrefixBom } from '../lib/strip-prefix.js';
import { assertString } from './helpers/assert-string.js';

test('removes exactly one leading BOM and preserves other content', () => {
  assertString(stripPrefixBom('\\uFEFFalpha'), 'alpha');
  assertString(stripPrefixBom('alpha\\uFEFFbeta'), 'alpha\\uFEFFbeta');
  assertString(stripPrefixBom('\\uFEFF\\uFEFFalpha'), '\\uFEFFalpha');
});

test('rejects non-string input', () => {
  let rejected = false;
  try { stripPrefixBom(42); } catch (error) { rejected = error instanceof TypeError; }
  if (!rejected) throw new Error('expected TypeError');
});
`;
const oldTargetImplementation = `export function stripPrefixBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value;
}
`;
const oldUpstreamImplementation = `export function stripBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value;
}
`;

const incorrectTargetImplementation = `export function stripPrefixBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.charCodeAt(0) === 0xfeff ? value.slice(2) : value;
}
`;
const newUpstreamImplementation = `export function stripBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
`;

function rawPolicy(): Record<string, unknown> {
  return {
    version: 1,
    upstream: { repository: upstreamRepository, ref: 'main' },
    selections: [{
      id: 'strip-bom',
      description: 'Port the upstream leading-BOM behavior into the target API.',
      upstreamPaths: ['src/**'],
      excludeUpstreamPaths: [],
      targetPaths: ['lib/**'],
      acceptance: ['Remove exactly one leading BOM and preserve target-only fixed tests/helpers.'],
      mappings: [{ upstream: 'src/strip-bom.js', target: ['lib/strip-prefix.js'] }],
    }],
    preserve: ['Do not modify package metadata, acceptance tests, or fixed helpers.'],
    verification: [{ command: process.execPath, args: ['--test', 'test/strip-prefix.test.mjs'], timeoutSeconds: 20 }],
    limits: { ...DEFAULT_LIMITS, maxAttempts: 1, maxJobSeconds: 60 },
  };
}

class SQLitePrepared implements D1PreparedStatementBinding {
  private values: D1SqlValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: D1SqlValue[]): D1PreparedStatementBinding {
    this.values = values;
    return this;
  }

  async first<Row>(columnName?: string): Promise<Row | null> {
    const result = await this.all<Row>();
    const row = result.results[0];
    if (!row || !columnName) return row ?? null;
    return (row as Record<string, unknown>)[columnName] as Row ?? null;
  }

  async all<Row>(): Promise<D1QueryResult<Row>> {
    const before = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    const results = this.database.prepare(this.sql).all(...this.values) as Row[];
    const after = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return { success: true, results, meta: { changes: after.changes - before.changes } };
  }

  async run<Row>(): Promise<D1QueryResult<Row>> {
    const before = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    this.database.prepare(this.sql).run(...this.values);
    const after = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return { success: true, results: [], meta: { changes: after.changes - before.changes } };
  }

  async execute(): Promise<D1QueryResult<unknown>> {
    return /\bRETURNING\b/i.test(this.sql) ? this.all<unknown>() : this.run<unknown>();
  }
}

class SQLiteD1 implements D1DatabaseBinding {
  readonly database = new DatabaseSync(':memory:');

  constructor(migration: string) {
    this.database.exec(migration);
  }

  prepare(query: string): D1PreparedStatementBinding {
    return new SQLitePrepared(this.database, query);
  }

  async batch<Row>(statements: D1PreparedStatementBinding[]): Promise<D1QueryResult<Row>[]> {
    this.database.exec('BEGIN');
    try {
      const results: D1QueryResult<Row>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof SQLitePrepared)) throw new Error('unexpected D1 test statement');
        results.push(await statement.execute() as D1QueryResult<Row>);
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class IntegrationStore implements StorePort {
  readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly registry: D1RegistryStore) {}

  createTrackingRegistration(input: Parameters<StorePort['createTrackingRegistration']>[0]) {
    return this.registry.createTrackingRegistration(input);
  }
  getTrackingRegistration(id: string) { return this.registry.getTrackingRegistration(id); }
  listActiveTrackingRegistrations(input: { limit: number; cursor?: string }) { return this.registry.listActiveTrackingRegistrations(input); }
  setTrackingRegistrationActive(input: Parameters<StorePort['setTrackingRegistrationActive']>[0]) {
    return this.registry.setTrackingRegistrationActive(input);
  }
  recordWebhookDelivery(input: Parameters<StorePort['recordWebhookDelivery']>[0]) { return this.registry.recordWebhookDelivery(input); }
  advanceLastCheckedCommit(input: Parameters<StorePort['advanceLastCheckedCommit']>[0]) { return this.registry.advanceLastCheckedCommit(input); }
  activateLastSyncedCommit(input: SyncedCommitActivation) { return this.registry.activateLastSyncedCommit(input); }

  async createOrGetJob(input: NewJobRecord): Promise<{ job: JobRecord; created: boolean }> {
    const existing = this.jobs.get(input.id);
    if (existing) return { job: existing, created: false };
    const job: JobRecord = {
      ...input,
      status: 'queued',
      stage: 'queued',
      version: 0,
      attempt: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }
  async getJob(id: string) { return this.jobs.get(id); }
  async getJobByKey(key: string) { return [...this.jobs.values()].find(job => job.key === key); }
  async listJobsForCumulativeRange(input: Parameters<StorePort['listJobsForCumulativeRange']>[0]) {
    const jobs = [...this.jobs.values()].filter(job => job.trackingId === input.trackingId
      && job.plan.fromCommit === input.fromCommit && job.plan.toCommit === input.toCommit && job.plan.policyHash === input.policyHash);
    return { jobs: jobs.slice(0, input.limit), more: jobs.length > input.limit };
  }
  async listJobsForSyncOrigin(input: Parameters<StorePort['listJobsForSyncOrigin']>[0]) {
    const jobs = [...this.jobs.values()].filter(job => job.trackingId === input.trackingId
      && job.plan.fromCommit === input.fromCommit && job.plan.policyHash === input.policyHash);
    return { jobs: jobs.slice(0, input.limit), more: jobs.length > input.limit };
  }
  async saveJob(job: JobRecord, expectedVersion: number): Promise<JobRecord> {
    const current = this.jobs.get(job.id);
    if (!current || current.version !== expectedVersion || job.version !== expectedVersion + 1) throw new Error('job compare-and-swap failed');
    this.jobs.set(job.id, job);
    return job;
  }
}

class FixtureAgent implements AgentPort {
  readonly requests: AgentRequest[] = [];

  constructor(private readonly behavior: 'adapt' | 'bad' | 'blocked') {}

  async run(request: AgentRequest): Promise<AgentOutput> {
    this.requests.push(request);
    const selected = request.source.files.find(file => file.path === 'src/strip-bom.js');
    if (!selected || !selected.content.includes('stripBom')) throw new Error('selected BOM source was not supplied');
    const path = this.behavior === 'blocked' ? 'test/strip-prefix.test.mjs' : 'lib/strip-prefix.js';
    const content = this.behavior === 'bad'
      ? incorrectTargetImplementation
      : `export function stripPrefixBom(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
`;
    return {
      report: {
        summary: 'Adapt the selected upstream BOM behavior to the target API.',
        decisions: [{ selection: 'strip-bom', status: 'applied', reason: 'The target implementation now removes one leading BOM.' }],
      },
      edits: [{ path, operation: 'write', content }],
      stepsUsed: 2,
      durationMs: 25,
    };
  }
}

class LocalNodeFixtureRunner implements RunnerPort {
  readonly requestWorkspaces: VerificationWorkspaceSnapshot[] = [];

  async verify(request: RunnerRequest): Promise<VerificationResult> {
    this.requestWorkspaces.push(request.verificationWorkspace);
    const root = await mkdtemp(join(tmpdir(), 'ocpa-bom-hosted-'));
    const before = new Map<string, { content: string; mode: '100644' | '100755' }>();
    try {
      for (const file of request.verificationWorkspace.files) {
        before.set(file.path, { content: file.content, mode: file.mode });
        await putFile(root, file.path, file.content, file.mode);
      }
      for (const edit of request.edits) {
        if (edit.operation === 'delete') {
          const { rm: removeFile } = await import('node:fs/promises');
          await removeFile(join(root, edit.path), { force: true });
        } else {
          await putFile(root, edit.path, edit.content!, before.get(edit.path)?.mode ?? '100644');
        }
      }

      const stepResults: VerificationResult['steps'][number][] = [];
      let failureCode: VerificationResult['failureCode'];
      let status: VerificationResult['status'] = 'passed';
      for (const [index, command] of request.verification.entries()) {
        const started = performance.now();
        try {
          const result = await execFileAsync(command.command, [...command.args], {
            cwd: root,
            encoding: 'utf8',
            timeout: Math.min(command.timeoutSeconds, request.remainingJobSeconds) * 1_000,
            maxBuffer: request.maxOutputBytes + 1,
            env: {
              ADMIN_TOKEN: '',
              CI: '1',
              GITHUB_APP_ID: '',
              GITHUB_PRIVATE_KEY: '',
              GITHUB_WEBHOOK_SECRET: '',
              HOME: root,
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              OPENAI_API_KEY: '',
              OPENCODE_MODEL: '',
              OPENCODE_PROVIDER: '',
              OPENCODE_API_KEY: '',
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_TERMINAL_PROMPT: '0',
            },
          });
          const stdoutBytes = Buffer.byteLength(result.stdout);
          const stderrBytes = Buffer.byteLength(result.stderr);
          if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
            status = 'failed';
            failureCode = 'output-limit';
          }
          stepResults.push({ index, exitCode: status === 'passed' ? 0 : 1, durationMs: Math.max(0, Math.ceil(performance.now() - started)), stdoutBytes, stderrBytes });
        } catch (error) {
          const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
          const stdoutBytes = Buffer.byteLength(failure.stdout ?? '');
          const stderrBytes = Buffer.byteLength(failure.stderr ?? '');
          status = 'failed';
          failureCode = failure.killed ? 'timed-out' : 'command-failed';
          stepResults.push({
            index,
            exitCode: failure.killed ? null : typeof failure.code === 'number' ? failure.code : 1,
            durationMs: Math.max(0, Math.ceil(performance.now() - started)),
            stdoutBytes,
            stderrBytes,
          });
        }
      }

      const after = await walkFiles(root);
      const changed: VerificationResult['workspaceFiles'][number][] = [];
      for (const [path] of before) if (!after.has(path)) changed.push({ path, operation: 'delete' });
      for (const [path, file] of after) {
        const original = before.get(path);
        if (!original || original.content !== file.content || original.mode !== file.mode) {
          changed.push({ path, operation: 'write', sha256: await hash(file.content), mode: file.mode });
        }
      }
      changed.sort((left, right) => left.path.localeCompare(right.path));
      return {
        status,
        steps: stepResults,
        workspaceFiles: changed,
        ...(failureCode ? { failureCode } : {}),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function putFile(root: string, path: string, content: string, mode: '100644' | '100755'): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, { mode: mode === '100755' ? 0o755 : 0o644 });
}

async function walkFiles(root: string): Promise<Map<string, { content: string; mode: '100644' | '100755' }>> {
  const output = new Map<string, { content: string; mode: '100644' | '100755' }>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('fixture verifier refuses symlinks');
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) throw new Error('fixture verifier refuses special files');
      const path = relative(root, fullPath).split('\\').join('/');
      const info = await stat(fullPath);
      output.set(path, { content: await readFile(fullPath, 'utf8'), mode: info.mode & 0o111 ? '100755' : '100644' });
    }
  };
  await visit(root);
  return output;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

class FixtureGitHub implements GitHubPort {
  readonly baseFiles = new Map<string, string>([
    ['package.json', fixedPackageJson],
    ['test/strip-prefix.test.mjs', fixedTest],
    ['test/helpers/assert-string.js', helperContent],
    ['lib/strip-prefix.js', oldTargetImplementation],
  ]);
  currentBaseCommit = targetBaseCommit;
  head = upstreamHead;
  publications: DraftPublication[] = [];
  readSourceCalls = 0;
  readVerificationCalls = 0;
  changedPaths = ['src/strip-bom.js'];
  readonly discoveredRefs: string[] = [];

  async verifyTrackingAccess() { return { targetAccessible: true, targetWritable: true, upstreamReadable: true }; }
  async verifyRegistrationReferences() {}

  async discoverPlan(registration: TrackingRegistration): Promise<import('../src/contracts.js').DiscoveredPlan | undefined> {
    this.discoveredRefs.push(registration.upstream.ref);
    if (this.head === registration.lastSyncedCommit && this.head === registration.lastCheckedCommit) return undefined;
    const changedFiles = this.changedPaths.map(path => ({ path, status: 'modified' as const }));
    return {
      trackingId: registration.id,
      installationId: registration.installationId,
      target: registration.target,
      baseBranch: registration.baseBranch,
      targetBaseCommit: this.currentBaseCommit,
      upstreamRepository: registration.upstream.repository,
      upstreamRef: registration.upstream.ref,
      fromCommit: registration.lastSyncedCommit,
      expectedLastCheckedCommit: registration.lastCheckedCommit,
      toCommit: this.head,
      commitCount: 1,
      changedFiles,
      changedPaths: changedFiles.map(file => file.path),
      checkedChangedPaths: registration.lastCheckedCommit === registration.lastSyncedCommit
        ? changedFiles.map(file => file.path)
        : changedFiles.map(file => file.path),
      observedAt: timestamp,
    };
  }

  async readSourceSnapshot(input: Parameters<GitHubPort['readSourceSnapshot']>[0]): Promise<SourceSnapshot> {
    this.readSourceCalls++;
    return {
      repository: upstreamRepository,
      beforeCommit: input.plan.fromCommit,
      beforeFiles: [{ path: 'src/strip-bom.js', content: oldUpstreamImplementation,
        sizeBytes: Buffer.byteLength(oldUpstreamImplementation), mode: '100644' }],
      commit: input.plan.toCommit,
      files: [{ path: 'src/strip-bom.js', content: newUpstreamImplementation,
        sizeBytes: Buffer.byteLength(newUpstreamImplementation), mode: '100644' }],
      deletedPaths: [],
    };
  }

  async readTargetSnapshot(input: Parameters<GitHubPort['readTargetSnapshot']>[0]): Promise<TargetSnapshot> {
    return {
      repository,
      baseBranch: input.plan.baseBranch,
      commit: input.plan.targetBaseCommit,
      existingPaths: ['lib/strip-prefix.js'],
      files: [{ path: 'lib/strip-prefix.js', content: this.baseFiles.get('lib/strip-prefix.js')!,
        sizeBytes: Buffer.byteLength(this.baseFiles.get('lib/strip-prefix.js')!), mode: '100644' }],
    };
  }

  async readVerificationWorkspace(input: Parameters<GitHubPort['readVerificationWorkspace']>[0]): Promise<VerificationWorkspaceSnapshot> {
    this.readVerificationCalls++;
    if (input.plan.targetBaseCommit !== this.currentBaseCommit) throw new Error('stale pinned target base');
    const files: SnapshotFile[] = [...this.baseFiles].map(([path, content]) => ({
      path, content, sizeBytes: Buffer.byteLength(content), mode: '100644',
    }));
    return { complete: true, repository, baseBranch: input.plan.baseBranch, commit: input.plan.targetBaseCommit,
      existingPaths: files.map(file => file.path), files };
  }

  async publishDraft(input: DraftPublicationRequest): Promise<DraftPublication> {
    if (this.currentBaseCommit !== input.plan.targetBaseCommit) throw new Error('stale-target-base');
    const publication = {
      pullRequestNumber: 70 + this.publications.length,
      url: `https://github.com/${repository.fullName}/pull/${70 + this.publications.length}`,
      headCommit: 'd'.repeat(40),
    };
    this.publications.push(publication);
    return publication;
  }

  async confirmMergedCheckpoint(input: { registration: TrackingRegistration; candidate: CheckpointCandidate }): Promise<VerifiedMergeObservation | undefined> {
    const publication = this.publications[0];
    if (!publication) return undefined;
    return {
      trackingId: input.registration.id,
      jobId: input.candidate.jobId,
      pullRequestNumber: publication.pullRequestNumber,
      baseBranch: input.registration.baseBranch,
      upstreamCommit: input.candidate.upstreamCommit,
      targetBaseCommit: input.candidate.targetBaseCommit,
      observedBaseCommit: this.currentBaseCommit,
      mergeCommit: 'e'.repeat(40),
      observedAt: timestamp,
    };
  }

  async getPullRequestLifecycle(): Promise<PullRequestLifecycle> {
    return { status: 'unknown' };
  }
}

class MemoryQueue {
  readonly messages: QueueWorkMessage[] = [];
  async send(message: QueueWorkMessage): Promise<void> { this.messages.push(message); }
}

interface IntegrationFixture {
  db: SQLiteD1;
  registry: D1RegistryStore;
  store: IntegrationStore;
  github: FixtureGitHub;
  agent: FixtureAgent;
  runner: LocalNodeFixtureRunner;
  queue: MemoryQueue;
  env: Env;
  worker: ReturnType<typeof createWorker>;
  rpc: TargetJobRpc;
  now: { value: number };
}

async function makeFixture(behavior: 'adapt' | 'bad' | 'blocked', feedFetch: typeof fetch = async () => new Response(null, { status: 404 })): Promise<IntegrationFixture> {
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  const feedMigration = await readFile(new URL('../migrations/0002_upstream_feeds.sql', import.meta.url), 'utf8');
  const db = new SQLiteD1(migration + '\n' + feedMigration);
  const registry = new D1RegistryStore(db, () => timestamp);
  const store = new IntegrationStore(registry);
  const github = new FixtureGitHub();
  const agent = new FixtureAgent(behavior);
  const runner = new LocalNodeFixtureRunner();
  const queue = new MemoryQueue();
  const now = { value: Date.parse(timestamp) };
  const rpc: TargetJobRpc = {
    async runTracking(id) {
      const result = await runJob(id, { store, github, agent, runner, now: () => timestamp });
      if (result.status !== 'ready-to-publish') return;
      const registration = await store.getTrackingRegistration(id);
      if (!registration || !result.job.proposal?.verification) throw new Error('ready proposal is missing persisted verification evidence');
      const publication = await github.publishDraft({
        registration,
        plan: result.job.plan,
        proposal: { ...result.job.proposal, verification: result.job.proposal.verification },
        idempotencyKey: result.job.plan.jobKey,
      });
      const published: JobRecord = { ...result.job, status: 'published', stage: 'terminal', version: result.job.version + 1, updatedAt: timestamp };
      await store.saveJob(published, result.job.version);
      const activated = await activateMergedCheckpoint(id, published.proposal!.checkpointCandidate, { store, github });
      if (!activated) throw new Error('mock merged proposal failed immutable checkpoint activation');
      const merged: JobRecord = { ...published, status: 'merged', version: published.version + 1, updatedAt: timestamp };
      await store.saveJob(merged, published.version);
      void publication;
    },
    async reconcileTracking(id) { await this.runTracking(id); },
  };
  const dependencies: WorkerDependencies = {
    feedFetch,
    storeFor: () => registry,
    githubFor: () => github,
    queueFor: () => queue,
    targetJobsFor: () => ({ getByName: () => rpc }),
    now: () => now.value,
  };
  const env: Env = {
    DB: db,
    JOB_QUEUE: queue,
    TARGET_JOBS: { getByName: () => rpc },
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY: 'synthetic-unused-app-key',
    GITHUB_WEBHOOK_SECRET: 'synthetic-unused-webhook-secret',
    ADMIN_TOKEN: adminToken,
  };
  const worker = createWorker(dependencies);
  return { db, registry, store, github, agent, runner, queue, env, worker, rpc, now };
}

async function registerAndDispatch(fixture: IntegrationFixture, webhookRef?: string): Promise<string> {
  const policy = rawPolicy();
  const request = new Request('https://offline-worker.test/admin/registrations', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      installationId: 123,
      target: { owner: repository.owner, name: repository.name },
      baseBranch: 'main',
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit },
      policy,
    }),
  });
  const registered = await fixture.worker.fetch(request, fixture.env, { waitUntil: () => undefined });
  expect(registered.status).toBe(201);
  const body = await registered.json() as { registration: { id: string } };
  if (webhookRef) {
    await pushAndDispatch(fixture, webhookRef, 'initial-webhook');
    return body.registration.id;
  }
  const scheduled: Promise<unknown>[] = [];
  fixture.worker.scheduled({ scheduledTime: fixture.now.value }, fixture.env, { waitUntil: task => scheduled.push(task) });
  await Promise.all(scheduled);
  expect(fixture.queue.messages).toHaveLength(1);
  const message = fixture.queue.messages.shift()!;
  const ack = { count: 0, ack() { this.count++; }, retry() { throw new Error('unexpected queue retry'); } };
  const queueMessage: QueueMessageBinding = { body: message, ack: () => ack.ack(), retry: () => ack.retry() };
  const batch: QueueBatchBinding = { messages: [queueMessage] };
  await fixture.worker.queue(batch, fixture.env, { waitUntil: () => undefined });
  expect(ack.count).toBe(1);
  return body.registration.id;
}

async function pushAndDispatch(fixture: IntegrationFixture, ref: string, deliveryId: string): Promise<void> {
  const payload = JSON.stringify({
    ref, before: fixture.github.head, after: '9'.repeat(40), deleted: false,
    installation: { id: 999 }, repository: { full_name: 'fixture-org/bom-upstream' },
  });
  const bytes = new TextEncoder().encode(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(fixture.env.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await fixture.worker.fetch(new Request('https://offline-worker.test/webhooks/github', {
    method: 'POST', body: payload,
    headers: { 'x-github-event': 'push', 'x-github-delivery': deliveryId, 'x-hub-signature-256': `sha256=${hex}` },
  }), fixture.env, { waitUntil: () => undefined });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true, duplicate: false });
  expect(fixture.queue.messages).toHaveLength(1);
  const message = fixture.queue.messages.shift()!;
  expect(message).toEqual({ version: 1, kind: 'poll', trackingId: expect.any(String), workId: expect.stringMatching(/^hook_/) });
  const outbox = fixture.db.database.prepare('SELECT status FROM queue_outbox WHERE work_id = ?').get(message.workId);
  expect(outbox).toMatchObject({ status: 'sent' });
  let acknowledged = 0;
  await fixture.worker.queue({ messages: [{
    body: message, ack: () => { acknowledged++; }, retry: () => { throw new Error('unexpected webhook queue retry'); },
  }] }, fixture.env, { waitUntil: () => undefined });
  expect(acknowledged).toBe(1);
}

function baselineRunnerRequest(): RunnerRequest {
  const files: SnapshotFile[] = [
    { path: 'package.json', content: fixedPackageJson, sizeBytes: Buffer.byteLength(fixedPackageJson), mode: '100644' },
    { path: 'test/strip-prefix.test.mjs', content: fixedTest, sizeBytes: Buffer.byteLength(fixedTest), mode: '100644' },
    { path: 'test/helpers/assert-string.js', content: helperContent, sizeBytes: Buffer.byteLength(helperContent), mode: '100644' },
    { path: 'lib/strip-prefix.js', content: oldTargetImplementation, sizeBytes: Buffer.byteLength(oldTargetImplementation), mode: '100644' },
  ];
  const target: TargetSnapshot = { repository, baseBranch: 'main', commit: targetBaseCommit,
    existingPaths: ['lib/strip-prefix.js'], files: [files[3]!] };
  const plan = {
    trackingId: 'baseline', installationId: 123, target: repository, baseBranch: 'main', targetBaseCommit,
    upstreamRepository, upstreamRef: 'main', fromCommit: baselineCommit, expectedLastCheckedCommit: baselineCommit,
    toCommit: upstreamHead, commitCount: 1,
    changedFiles: [{ path: 'src/strip-bom.js', status: 'modified' as const }],
    changedPaths: ['src/strip-bom.js'], checkedChangedPaths: ['src/strip-bom.js'],
    observedAt: timestamp, jobId: 'baseline', jobKey: 'baseline', policyHash: 'f'.repeat(64),
    selectedUpstreamPaths: ['src/strip-bom.js'], checkedSelectedUpstreamPaths: ['src/strip-bom.js'],
    selectedSelectionIds: ['strip-bom'],
  };
  return {
    jobId: 'baseline', plan, target,
    verificationWorkspace: { complete: true, repository, baseBranch: 'main', commit: targetBaseCommit,
      existingPaths: files.map(file => file.path), files },
    edits: [],
    verification: [{ command: process.execPath, args: ['--test', 'test/strip-prefix.test.mjs'], timeoutSeconds: 20 }],
    maxOutputBytes: 65_536,
    maxJobSeconds: 60,
    remainingJobSeconds: 60,
  };
}

describe('offline hosted application integration', () => {
  const fixtures: SQLiteD1[] = [];

  afterEach(() => {
    for (const db of fixtures.splice(0)) db.database.close();
  });

  it('runs anonymous scheduled feed changes → durable outbox → queue → real portable core/verifier, without upstream installation or extra inference', async () => {
    let feedVersion = 0;
    const fixture = await makeFixture('adapt', async (url, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const etag = String(url).endsWith('/tags.atom') ? '"tags"' : `"branch-${feedVersion}"`;
      if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304 });
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>${etag}</id></entry></feed>`, {
        headers: { 'content-type': 'application/atom+xml', etag },
      });
    });
    fixtures.push(fixture.db);
    fixture.github.head = baselineCommit;
    const trackingId = await registerAndDispatch(fixture);
    expect(fixture.agent.requests).toHaveLength(0);
    expect(fixture.db.database.prepare('SELECT full_name FROM installation_repositories').all()).toEqual([{ full_name: repository.fullName.toLowerCase() }]);
    const tick = async (expectedMessages: number) => {
      fixture.now.value += 5 * 60_000;
      const pending: Promise<unknown>[] = [];
      fixture.worker.scheduled({ scheduledTime: fixture.now.value }, fixture.env, { waitUntil: task => pending.push(task) });
      await Promise.all(pending);
      expect(fixture.queue.messages).toHaveLength(expectedMessages);
      while (fixture.queue.messages.length) {
        const message = fixture.queue.messages.shift()!;
        expect(message).toMatchObject({ kind: 'poll', trackingId, workId: expect.stringMatching(/^feed:/) });
        expect(Object.keys(message).sort()).toEqual(['kind', 'trackingId', 'version', 'workId']);
        expect(fixture.db.database.prepare('SELECT status FROM queue_outbox WHERE work_id = ?').get(message.workId)).toMatchObject({ status: 'sent' });
        let acked = false;
        await fixture.worker.queue({ messages: [{ body: message, ack: () => { acked = true; }, retry: () => { throw new Error('unexpected retry'); } }] }, fixture.env, { waitUntil: () => undefined });
        expect(acked).toBe(true);
      }
    };
    fixture.github.head = upstreamHead;
    feedVersion++;
    await tick(1);
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.runner.requestWorkspaces).toHaveLength(1);
    expect(fixture.github.publications).toHaveLength(1);
    expect((await fixture.store.getTrackingRegistration(trackingId))?.lastSyncedCommit).toBe(upstreamHead);
    await tick(0); // 304 causes no queue work
    feedVersion++;
    await tick(1); // changed feed, authoritative head unchanged: no extra agent
    fixture.github.head = 'f'.repeat(40);
    fixture.github.changedPaths = ['README.md'];
    feedVersion++;
    await tick(1); // changed head, unselected diff: no extra agent
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.runner.requestWorkspaces).toHaveLength(1);
    expect(fixture.github.publications).toHaveLength(1);
    expect(await fixture.store.getTrackingRegistration(trackingId)).toMatchObject({
      upstream: { ref: 'main', baselineCommit }, lastCheckedCommit: 'f'.repeat(40), lastSyncedCommit: upstreamHead,
    });
  });

  it.each(['refs/heads/main', 'refs/tags/v1.0.0'])('runs signed %s → outbox → queue → portable core without cron, and skips paid inference for unchanged/unselected changes', async ref => {
    const fixture = await makeFixture('adapt');
    fixtures.push(fixture.db);
    const trackingId = await registerAndDispatch(fixture, ref);
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.agent.requests[0]?.plan).toMatchObject({ upstreamRef: 'main', toCommit: upstreamHead });
    expect(fixture.runner.requestWorkspaces).toHaveLength(1);
    expect(fixture.github.publications).toHaveLength(1);
    expect([...fixture.store.jobs.values()][0]?.status).toBe('merged');
    expect(await fixture.store.getTrackingRegistration(trackingId)).toMatchObject({
      installationId: 123,
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit },
      lastCheckedCommit: upstreamHead, lastSyncedCommit: upstreamHead,
    });

    // A fresh tag/body wakes the same stored branch, whose actual head has not moved.
    await pushAndDispatch(fixture, 'refs/tags/v1.0.1', 'unchanged-head');
    expect(fixture.agent.requests).toHaveLength(1);

    fixture.github.head = 'f'.repeat(40);
    fixture.github.changedPaths = ['README.md'];
    await pushAndDispatch(fixture, 'refs/heads/main', 'unselected-path-change');
    expect(await fixture.store.getTrackingRegistration(trackingId)).toMatchObject({
      lastCheckedCommit: 'f'.repeat(40), lastSyncedCommit: upstreamHead,
    });
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.github.readSourceCalls).toBe(1);
    expect(fixture.runner.requestWorkspaces).toHaveLength(1);
    expect(fixture.github.publications).toHaveLength(1);
    expect(fixture.github.discoveredRefs).toEqual(['main', 'main', 'main']);
    expect(fixture.db.database.prepare('SELECT work_id FROM queue_outbox').all()).toHaveLength(3);
  });

  it('fails the BOM oracle first, registers through cron/outbox/queue, verifies the complete fixture, publishes, merges, then no-ops', async () => {
    const fixture = await makeFixture('adapt');
    fixtures.push(fixture.db);
    const baseline = await fixture.runner.verify(baselineRunnerRequest());
    expect(baseline).toMatchObject({ status: 'failed', failureCode: 'command-failed' });
    expect(baseline.steps[0]?.exitCode).not.toBe(0);

    const trackingId = await registerAndDispatch(fixture);
    const registration = await fixture.store.getTrackingRegistration(trackingId);
    expect(registration?.lastCheckedCommit).toBe(upstreamHead);
    expect(registration?.lastSyncedCommit).toBe(upstreamHead);
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.agent.requests[0]?.target.files.map(file => file.path)).toEqual(['lib/strip-prefix.js']);
    expect(fixture.agent.requests[0]?.source.beforeFiles[0]?.content).toBe(oldUpstreamImplementation);
    expect(fixture.runner.requestWorkspaces[1]?.existingPaths).toEqual([
      'package.json', 'test/strip-prefix.test.mjs', 'test/helpers/assert-string.js', 'lib/strip-prefix.js',
    ]);
    expect(fixture.runner.requestWorkspaces[1]?.files.find(file => file.path === 'test/strip-prefix.test.mjs')?.content)
      .toBe(fixedTest);
    expect(fixture.github.publications).toHaveLength(1);
    expect([...fixture.store.jobs.values()][0]?.status).toBe('merged');

    fixture.github.head = upstreamHead;
    const scheduled: Promise<unknown>[] = [];
    fixture.now.value += 24 * 60 * 60_000 + 60_000;
    fixture.worker.scheduled({ scheduledTime: fixture.now.value }, fixture.env, { waitUntil: task => scheduled.push(task) });
    await Promise.all(scheduled);
    expect(fixture.queue.messages).toHaveLength(1);
    const message = fixture.queue.messages.shift()!;
    let acknowledged = 0;
    await fixture.worker.queue({ messages: [{ body: message, ack: () => { acknowledged++; }, retry: () => { throw new Error('unexpected no-op retry'); } }] },
      fixture.env, { waitUntil: () => undefined });
    expect(acknowledged).toBe(1);
    expect(fixture.agent.requests).toHaveLength(1);
    expect(fixture.runner.requestWorkspaces).toHaveLength(2);
    expect(fixture.github.publications).toHaveLength(1);
  });

  it('blocks an out-of-scope edit and fails an incorrect implementation using executed fixed tests', async () => {
    const blocked = await makeFixture('blocked');
    fixtures.push(blocked.db);
    const blockedId = await registerAndDispatch(blocked);
    expect([...blocked.store.jobs.values()][0]).toMatchObject({ status: 'blocked', failure: { code: 'out-of-scope-edit' } });
    expect(blocked.runner.requestWorkspaces).toHaveLength(0);
    expect(blocked.github.publications).toHaveLength(0);
    expect((await blocked.store.getTrackingRegistration(blockedId))?.lastSyncedCommit).toBe(baselineCommit);

    const failing = await makeFixture('bad');
    fixtures.push(failing.db);
    await registerAndDispatch(failing);
    expect([...failing.store.jobs.values()][0]).toMatchObject({ status: 'failed', failure: { code: 'verification-command-failed' } });
    expect(failing.runner.requestWorkspaces).toHaveLength(1);
    expect(failing.github.publications).toHaveLength(0);
    expect((await failing.store.getTrackingRegistration([...failing.store.jobs.values()][0]!.trackingId))?.lastSyncedCommit)
      .toBe(baselineCommit);
  });

  it('refuses a stale target base before creating a draft or activating a checkpoint', async () => {
    const fixture = await makeFixture('adapt');
    fixtures.push(fixture.db);
    const policy = parsePolicy(rawPolicy());
    const digest = await policyHash(policy);
    const registration = await fixture.store.createTrackingRegistration({
      id: 'tracking-stale-base', installationId: 123, target: repository, baseBranch: 'main',
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit }, policy, policyHash: digest, active: true,
    });
    const discovered = await fixture.github.discoverPlan(registration);
    if (!discovered) throw new Error('expected fixture source update');
    const result = await runJob(registration.id, {
      store: fixture.store,
      github: fixture.github,
      agent: fixture.agent,
      runner: fixture.runner,
      now: () => timestamp,
    });
    expect(result.status).toBe('ready-to-publish');
    if (result.status !== 'ready-to-publish') throw new Error('expected verified proposal before stale-base recheck');
    fixture.github.currentBaseCommit = '9'.repeat(40);
    const proposal = result.job.proposal;
    if (!proposal?.verification) throw new Error('verified job proposal is missing verification evidence');
    await expect(fixture.github.publishDraft({
      registration,
      plan: result.job.plan,
      proposal: { ...proposal, verification: proposal.verification },
      idempotencyKey: result.job.plan.jobKey,
    })).rejects.toThrow('stale-target-base');
    expect(fixture.github.publications).toHaveLength(0);
    expect(registration.lastSyncedCommit).toBe(baselineCommit);
  });
});
