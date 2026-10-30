import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type {
  CheckedCommitAdvance,
  CheckpointCandidate,
  DiscoveredPlan,
  DraftPublicationRequest,
  JobRecord,
  NewJobRecord,
  NewTrackingRegistration,
  RepositoryIdentity,
  SourceSnapshot,
  SyncedCommitActivation,
  TargetSnapshot,
  TrackingId,
  TrackingRegistration,
  PullRequestLifecycle,
  VerificationResult,
  VerificationWorkspaceSnapshot,
  WebhookDelivery,
} from '../src/contracts.js';
import { GitHubClientError, type RegistrationGitHubPort } from '../src/github.js';
import { DEFAULT_LIMITS, parsePolicy, policyHash } from '../src/policy.js';
import {
  D1RegistryStore,
  flushQueueOutbox,
  type D1DatabaseBinding,
  type D1PreparedStatementBinding,
  type D1QueryResult,
  type D1SqlValue,
  type InstallationRepositoriesWebhookUpdate,
  type InstallationWebhookUpdate,
  type PullRequestWebhookUpdate,
  type QueueOutboxRecord,
  type QueueWorkMessage,
  type WebhookPayloadEvidence,
} from '../src/store.js';
import {
  consumeQueueBatch,
  createWorker,
  runScheduler,
  type WorkerDependencies,
} from '../src/worker.js';
import type { Env, QueueBatchBinding, QueueMessageBinding, TargetJobRpc } from '../src/env.js';

const target: RepositoryIdentity = { owner: 'target-org', name: 'target', fullName: 'target-org/target' };
const upstreamRepository = 'https://github.com/upstream-org/project.git';
const baseline = 'a'.repeat(40);
const nowMs = Date.parse('2026-10-09T12:00:00.000Z');
const nowIso = new Date(nowMs).toISOString();
const adminToken = 'operator-secret-value-with-enough-entropy';
const webhookSecret = 'local-webhook-secret';

function rawPolicy(): Record<string, unknown> {
  return {
    version: 1,
    upstream: { repository: upstreamRepository, ref: 'main' },
    selections: [{
      id: 'parser',
      description: 'Port parser behavior',
      upstreamPaths: ['src/**'],
      excludeUpstreamPaths: [],
      targetPaths: ['lib/**'],
      acceptance: ['Keep the parser behavior aligned.'],
      mappings: [{ upstream: 'src/parser.ts', target: ['lib/parser.ts'] }],
    }],
    preserve: ['Keep target-specific helpers.'],
    verification: [{ command: 'node', args: ['test.js'], timeoutSeconds: 15 }],
    limits: { ...DEFAULT_LIMITS },
  };
}

class MemoryControlPlaneStore {
  readonly registrations = new Map<string, TrackingRegistration>();
  readonly deliveries = new Map<string, { expiresAt: string; payloadClass: 'lifecycle' | 'event' }>();
  readonly outbox = new Map<string, QueueOutboxRecord & { status: 'pending' | 'sent'; createdAt: string; nextAttemptAt: string }>();
  readonly nextDueAt = new Map<string, string>();
  readonly activations: SyncedCommitActivation[] = [];

  async createTrackingRegistration(input: NewTrackingRegistration): Promise<TrackingRegistration> {
    if (this.registrations.has(input.id) || [...this.registrations.values()].some(item => item.installationId === input.installationId
      && item.target.fullName.toLowerCase() === input.target.fullName.toLowerCase() && item.baseBranch === input.baseBranch)) {
      throw new Error('duplicate registration');
    }
    const registration: TrackingRegistration = {
      ...input,
      lastCheckedCommit: input.upstream.baselineCommit,
      lastSyncedCommit: input.upstream.baselineCommit,
      revision: 1,
    };
    this.registrations.set(input.id, registration);
    this.nextDueAt.set(input.id, nowIso);
    return registration;
  }

  seed(registration: TrackingRegistration): void {
    this.registrations.set(registration.id, registration);
    this.nextDueAt.set(registration.id, nowIso);
  }

  async getTrackingRegistration(trackingId: string): Promise<TrackingRegistration | undefined> {
    return this.registrations.get(trackingId);
  }

  async listActiveTrackingRegistrations(input: { limit: number; cursor?: string }) {
    const active = [...this.registrations.values()].filter(item => item.active && (!input.cursor || item.id > input.cursor)).sort((a, b) => a.id.localeCompare(b.id));
    const registrations = active.slice(0, input.limit);
    return {
      registrations,
      ...(active.length > input.limit && registrations.length ? { nextCursor: registrations.at(-1)!.id } : {}),
    };
  }

  async isTrackingEligible(trackingId: string): Promise<boolean> {
    return this.registrations.get(trackingId)?.active === true;
  }

  async setTrackingRegistrationActive(input: { trackingId: string; expectedRevision: number; active: boolean }): Promise<boolean> {
    const registration = this.registrations.get(input.trackingId);
    if (!registration || registration.revision !== input.expectedRevision) return false;
    registration.active = input.active;
    registration.revision++;
    if (input.active) this.nextDueAt.set(input.trackingId, nowIso);
    return true;
  }

  async recordWebhookDelivery(input: WebhookDelivery, evidence?: WebhookPayloadEvidence): Promise<boolean> {
    const proof = evidence ?? { payloadDigest: input.deliveryId, payloadClass: 'event' as const };
    const key = `${input.installationId}:${proof.payloadDigest}`;
    const previous = this.deliveries.get(key);
    if (previous && (previous.payloadClass === 'lifecycle' || Date.parse(previous.expiresAt) > Date.parse(input.receivedAt))) return false;
    this.deliveries.set(key, { expiresAt: input.expiresAt, payloadClass: proof.payloadClass });
    return true;
  }

  async applyInstallationWebhook(input: InstallationWebhookUpdate): Promise<boolean> {
    const accepted = await this.recordWebhookDelivery(input.delivery, input.evidence);
    if (!accepted) return false;
    if (input.action === 'suspend' || input.action === 'deleted' || input.action === 'new_permissions_accepted') {
      for (const registration of this.registrations.values()) {
        if (registration.installationId === input.delivery.installationId && registration.active
          && input.confirmedInaccessibleTrackingIds.some(item => item.trackingId === registration.id
            && item.expectedRevision === registration.revision)) {
          registration.active = false;
          registration.revision++;
        }
      }
    }
    return true;
  }

  async applyInstallationRepositoriesWebhook(input: InstallationRepositoriesWebhookUpdate): Promise<boolean> {
    const accepted = await this.recordWebhookDelivery(input.delivery, input.evidence);
    if (!accepted) return false;
    for (const removed of input.removed) {
      for (const registration of this.registrations.values()) {
        if (registration.installationId === input.delivery.installationId
          && registration.target.fullName.toLowerCase() === removed.toLowerCase() && registration.active
          && input.confirmedRemovedTrackingIds.some(item => item.trackingId === registration.id
            && item.expectedRevision === registration.revision)) {
          registration.active = false;
          registration.revision++;
        }
      }
    }
    return true;
  }

  async enqueueMergedPullRequestReconciliation(input: PullRequestWebhookUpdate): Promise<boolean> {
    const accepted = await this.recordWebhookDelivery(input.delivery, input.evidence);
    if (!accepted) return false;
    for (const registration of this.registrations.values()) {
      if (registration.installationId === input.delivery.installationId && registration.active
        && registration.target.fullName.toLowerCase() === input.repositoryFullName.toLowerCase()
        && registration.baseBranch === input.baseBranch) {
        const workId = `${input.workPrefix}:${registration.id}`;
        this.outbox.set(workId, { workId, trackingId: registration.id, kind: 'reconcile', attempts: 0, status: 'pending', createdAt: input.delivery.receivedAt, nextAttemptAt: input.delivery.receivedAt });
      }
    }
    return true;
  }

  async enqueueUpstreamPushPolls(): Promise<boolean> { throw new Error('not used'); }

  async enqueueWork(input: { workId: string; kind: QueueWorkMessage['kind']; trackingId: TrackingId; createdAt: string }): Promise<boolean> {
    const registration = this.registrations.get(input.trackingId);
    if (!registration?.active || this.outbox.has(input.workId)) return false;
    this.outbox.set(input.workId, {
      workId: input.workId,
      kind: input.kind,
      trackingId: input.trackingId,
      attempts: 0,
      status: 'pending',
      createdAt: input.createdAt,
      nextAttemptAt: input.createdAt,
    });
    return true;
  }

  async enqueueDuePolls(input: { now: string; nextDueAt: string; limit: number }): Promise<number> {
    let enqueued = 0;
    const due = [...this.nextDueAt.entries()].filter(([id, dueAt]) => dueAt <= input.now && this.registrations.get(id)?.active)
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, input.limit);
    for (const [trackingId, dueAt] of due) {
      const workId = `poll:${trackingId}:${dueAt}`;
      if (!this.outbox.has(workId)) {
        this.outbox.set(workId, { workId, trackingId, kind: 'poll', attempts: 0, status: 'pending', createdAt: input.now, nextAttemptAt: input.now });
        enqueued++;
      }
      this.nextDueAt.set(trackingId, input.nextDueAt);
    }
    return enqueued;
  }

  async listPendingOutbox(input: { now: string; limit: number }): Promise<readonly QueueOutboxRecord[]> {
    return [...this.outbox.values()].filter(item => item.status === 'pending' && item.nextAttemptAt <= input.now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, input.limit)
      .map(({ workId, kind, trackingId, attempts }) => ({ workId, kind, trackingId, attempts }));
  }

  async markOutboxSent(workId: string, _sentAt: string): Promise<boolean> {
    const item = this.outbox.get(workId);
    if (!item || item.status !== 'pending') return false;
    item.status = 'sent';
    item.attempts++;
    return true;
  }

  async markOutboxRetry(workId: string, nextAttemptAt: string): Promise<boolean> {
    const item = this.outbox.get(workId);
    if (!item || item.status !== 'pending') return false;
    item.attempts++;
    item.nextAttemptAt = nextAttemptAt;
    return true;
  }

  async pruneExpiredRecords(_input: { now: string; limit: number }): Promise<void> {}

  async advanceLastCheckedCommit(input: CheckedCommitAdvance): Promise<boolean> {
    const registration = this.registrations.get(input.trackingId);
    if (!registration || !registration.active || registration.policyHash !== input.policyHash) return false;
    if (registration.lastCheckedCommit !== input.expectedLastCheckedCommit && registration.lastCheckedCommit !== input.nextLastCheckedCommit) return false;
    registration.lastCheckedCommit = input.nextLastCheckedCommit;
    return true;
  }

  async activateLastSyncedCommit(input: SyncedCommitActivation): Promise<boolean> {
    this.activations.push(input);
    return true;
  }
}

class FakeGitHub implements RegistrationGitHubPort {
  access = { targetAccessible: true, targetWritable: true, upstreamReadable: true };
  accessCalls = 0;
  referenceCalls = 0;
  accessResolver: (() => Promise<typeof this.access>) | undefined = undefined;

  async verifyTrackingAccess() {
    this.accessCalls++;
    if (this.accessResolver) return this.accessResolver();
    return this.access;
  }
  async verifyRegistrationReferences(): Promise<void> { this.referenceCalls++; }
  async discoverPlan(): Promise<DiscoveredPlan | undefined> { return undefined; }
  async readSourceSnapshot(): Promise<SourceSnapshot> { throw new Error('not used'); }
  async readTargetSnapshot(): Promise<TargetSnapshot> { throw new Error('not used'); }
  async readVerificationWorkspace(): Promise<VerificationWorkspaceSnapshot> { throw new Error('not used'); }
  async publishDraft(_input: DraftPublicationRequest): Promise<{ pullRequestNumber: number; url: string; headCommit: string }> {
    throw new Error('not used');
  }
  async confirmMergedCheckpoint(): Promise<undefined> { return undefined; }
  async getPullRequestLifecycle(): Promise<PullRequestLifecycle> { return { status: 'unknown' }; }
}

class FakeQueue {
  readonly sent: QueueWorkMessage[] = [];
  fail = false;

  async send(message: QueueWorkMessage): Promise<void> {
    if (this.fail) throw new Error('queue unavailable');
    this.sent.push(message);
  }
}

class FakeDurableObject implements TargetJobRpc {
  readonly runs: string[] = [];
  readonly reconciliations: string[] = [];
  async runTracking(trackingId: string): Promise<void> { this.runs.push(trackingId); }
  async reconcileTracking(trackingId: string): Promise<void> { this.reconciliations.push(trackingId); }
}

function mockD1(): D1DatabaseBinding {
  const prepared: D1PreparedStatementBinding = {
    bind: () => prepared,
    first: async () => null,
    all: async () => ({ success: true, results: [] }),
    run: async () => ({ success: true, results: [], meta: { changes: 0 } }),
  };
  return { prepare: () => prepared, batch: async () => [] };
}

function setup() {
  const store = new MemoryControlPlaneStore();
  const github = new FakeGitHub();
  const queue = new FakeQueue();
  const durableObject = new FakeDurableObject();
  const env: Env = {
    DB: mockD1(),
    JOB_QUEUE: queue,
    TARGET_JOBS: { getByName: () => durableObject },
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY: 'private-key-held-by-worker',
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    ADMIN_TOKEN: adminToken,
  };
  const dependencies: WorkerDependencies = {
    storeFor: () => store,
    githubFor: () => github,
    queueFor: () => queue,
    targetJobsFor: () => env.TARGET_JOBS,
    now: () => nowMs,
  };
  const worker = createWorker(dependencies);
  return { store, github, queue, durableObject, env, dependencies, worker };
}

async function registerSeed(store: MemoryControlPlaneStore, input: { active?: boolean } = {}): Promise<TrackingRegistration> {
  const policy = parsePolicy(rawPolicy());
  const digest = await policyHash(policy);
  const registration: TrackingRegistration = {
    id: 'tracking_seed',
    installationId: 23,
    target,
    baseBranch: 'main',
    upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
    policy,
    policyHash: digest,
    lastCheckedCommit: baseline,
    lastSyncedCommit: baseline,
    active: input.active ?? true,
    revision: 1,
  };
  store.seed(registration);
  return registration;
}

async function signedWebhook(
  bodyText: string,
  event: string,
  deliveryId: string,
  signatureOverride?: string,
): Promise<Request> {
  const bytes = new TextEncoder().encode(bodyText);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  const signature = signatureOverride ?? `sha256=${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return new Request('https://worker.example/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': event,
      'x-github-delivery': deliveryId,
    },
    body: bodyText,
  });
}

function installationWebhookRecord(id = 23): Record<string, unknown> {
  return {
    id,
    account: { login: 'target-org', type: 'Organization' },
    app_id: 12345,
    target_id: 54321,
    target_type: 'Organization',
    repository_selection: 'selected',
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    events: ['installation', 'installation_repositories'],
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function queueMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe('authenticated GitHub App control plane', () => {
  it('keeps admin routes authenticated and validates target access before storing a registration', async () => {
    const { worker, env, github, store } = setup();
    const unauthorized = await worker.fetch(new Request('https://worker.example/admin/registrations'), env, { waitUntil: () => undefined });
    expect(unauthorized.status).toBe(401);
    const wrongToken = await worker.fetch(new Request('https://worker.example/admin/registrations', { headers: { authorization: 'Bearer wrong' } }), env, { waitUntil: () => undefined });
    expect(wrongToken.status).toBe(401);
    expect(github.accessCalls).toBe(0);

    const policy = rawPolicy();
    const request = new Request('https://worker.example/admin/registrations', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: 23,
        target: { owner: target.owner, name: target.name },
        baseBranch: 'main',
        upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
        policy,
      }),
    });
    const response = await worker.fetch(request, env, { waitUntil: () => undefined });
    expect(response.status).toBe(201);
    const responseBody = await response.json() as { registration: TrackingRegistration };
    expect(responseBody.registration.active).toBe(true);
    expect(responseBody.registration.lastCheckedCommit).toBe(baseline);
    expect(responseBody.registration.lastSyncedCommit).toBe(baseline);
    expect(github.accessCalls).toBe(1);
    expect(github.referenceCalls).toBe(1);
    expect(store.registrations.size).toBe(1);
  });

  it('denies registration when target access is read-only or upstream is not readable', async () => {
    const { worker, env, github, store } = setup();
    github.access = { targetAccessible: true, targetWritable: false, upstreamReadable: true };
    const response = await worker.fetch(new Request('https://worker.example/admin/registrations', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: 23,
        target: { owner: target.owner, name: target.name },
        baseBranch: 'main',
        upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
        policy: rawPolicy(),
      }),
    }), env, { waitUntil: () => undefined });
    expect(response.status).toBe(403);
    expect(store.registrations.size).toBe(0);
    expect(github.referenceCalls).toBe(0);
  });

  it('authenticates exact webhook bytes, persists replay protection, and queues merge events only as reconciliation hints', async () => {
    const { worker, env, store, queue, dependencies, durableObject } = setup();
    const registration = await registerSeed(store);
    const payload = JSON.stringify({
      action: 'closed',
      installation: { id: registration.installationId },
      repository: { full_name: target.fullName },
      pull_request: { number: 999, merged: true, base: { ref: 'main' } },
    });
    const badSignature = await signedWebhook(payload, 'pull_request', 'delivery-merge-1', 'sha256=00'.repeat(32));
    const rejected = await worker.fetch(badSignature, env, { waitUntil: () => undefined });
    expect(rejected.status).toBe(401);
    expect(store.deliveries.size).toBe(0);

    const request = await signedWebhook(payload, 'pull_request', 'delivery-merge-1');
    const accepted = await worker.fetch(request, env, { waitUntil: () => undefined });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, duplicate: false });
    const replay = await worker.fetch(await signedWebhook(payload, 'pull_request', 'delivery-merge-1'), env, { waitUntil: () => undefined });
    expect(await replay.json()).toMatchObject({ accepted: false, duplicate: true });
    const changedDeliveryHeader = await worker.fetch(await signedWebhook(payload, 'pull_request', 'delivery-merge-2'), env, { waitUntil: () => undefined });
    expect(await changedDeliveryHeader.json()).toMatchObject({ accepted: false, duplicate: true });
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toEqual({
      version: 1,
      workId: expect.stringMatching(/^hook_[a-f0-9]{64}:tracking_seed$/),
      kind: 'reconcile',
      trackingId: 'tracking_seed',
    });
    expect(Object.keys(queue.sent[0]!).sort()).toEqual(['kind', 'trackingId', 'version', 'workId']);
    expect(store.activations).toHaveLength(0);

    const message = queueMessage(queue.sent[0]!);
    const batch: QueueBatchBinding = { messages: [message] };
    await consumeQueueBatch(batch, env, dependencies);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(durableObject.reconciliations).toEqual(['tracking_seed']);
    expect(store.activations).toHaveLength(0);
  });

  it('ignores an unmerged close event and does not enqueue reconciliation', async () => {
    const { worker, env, store, queue } = setup();
    await registerSeed(store);
    const payload = JSON.stringify({
      action: 'closed',
      installation: { id: 23 },
      repository: { full_name: target.fullName },
      pull_request: { number: 101, merged: false, base: { ref: 'main' } },
    });
    const response = await worker.fetch(await signedWebhook(payload, 'pull_request', 'delivery-not-merged'), env, { waitUntil: () => undefined });
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(0);
    expect(store.deliveries.size).toBe(1);
  });

  it('persists due polling before enqueue, survives repeated cron ticks, and rechecks eligibility on queue consumption', async () => {
    const { env, store, queue, durableObject, dependencies } = setup();
    await registerSeed(store);
    await runScheduler(env, dependencies);
    await runScheduler(env, dependencies);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({ version: 1, kind: 'poll', trackingId: 'tracking_seed' });
    const repeated = queueMessage(queue.sent[0]!);
    await consumeQueueBatch({ messages: [repeated] }, env, dependencies);
    expect(durableObject.runs).toEqual(['tracking_seed']);
    expect(repeated.ack).toHaveBeenCalledOnce();

    const registration = store.registrations.get('tracking_seed')!;
    registration.active = false;
    const inactive = queueMessage(queue.sent[0]!);
    await consumeQueueBatch({ messages: [inactive] }, env, dependencies);
    expect(inactive.ack).toHaveBeenCalledOnce();
    expect(durableObject.runs).toEqual(['tracking_seed']);
  });

  it('retains queue work in the outbox when Queue.send fails and retries it after backoff', async () => {
    const { env, store, queue, dependencies } = setup();
    await registerSeed(store);
    queue.fail = true;
    await runScheduler(env, dependencies);
    expect(queue.sent).toHaveLength(0);
    const pending = [...store.outbox.values()][0];
    expect(pending?.status).toBe('pending');
    expect(pending?.attempts).toBe(1);
    expect(pending?.nextAttemptAt).toBe(new Date(nowMs + 30_000).toISOString());

    queue.fail = false;
    dependencies.now = () => nowMs + 31_000;
    await runScheduler(env, dependencies);
    expect(queue.sent).toHaveLength(1);
    expect([...store.outbox.values()][0]?.status).toBe('sent');
  });

  it('retries queue RPC failures and keeps app tokens, policy, and PR data out of messages', async () => {
    const { env, store, queue, dependencies } = setup();
    await registerSeed(store);
    const identityMessage: QueueWorkMessage = { version: 1, workId: 'manual:work-1', kind: 'poll', trackingId: 'tracking_seed' };
    const failedDo: TargetJobRpc = {
      runTracking: async () => { throw new Error('failure'); },
      reconcileTracking: async () => { throw new Error('failure'); },
    };
    const failingDependencies = { ...dependencies, targetJobsFor: () => ({ getByName: () => failedDo }) };
    const message = queueMessage(identityMessage);
    await consumeQueueBatch({ messages: [message] }, env, failingDependencies);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(queue.sent).toHaveLength(0);
  });

  it('suspends installation registrations and repository removal cannot reactivate them', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    github.access = { targetAccessible: false, targetWritable: false, upstreamReadable: false };
    const suspendPayload = JSON.stringify({ action: 'suspend', installation: installationWebhookRecord() });
    const suspended = await worker.fetch(await signedWebhook(suspendPayload, 'installation', 'delivery-suspend'), env, { waitUntil: () => undefined });
    expect(suspended.status).toBe(202);
    expect(store.registrations.get(registration.id)?.active).toBe(false);

    const resumePayload = JSON.stringify({ action: 'unsuspend', installation: installationWebhookRecord() });
    await worker.fetch(await signedWebhook(resumePayload, 'installation', 'delivery-unsuspend-before-operator'), env, { waitUntil: () => undefined });
    expect(store.registrations.get(registration.id)?.active).toBe(false);

    github.access = { targetAccessible: true, targetWritable: true, upstreamReadable: true };
    const revisionAfterSuspend = store.registrations.get(registration.id)!.revision;
    const reactivated = await worker.fetch(new Request(`https://worker.example/admin/registrations/${registration.id}/active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: true, expectedRevision: revisionAfterSuspend }),
    }), env, { waitUntil: () => undefined });
    expect(reactivated.status).toBe(200);
    expect(store.registrations.get(registration.id)?.active).toBe(true);

    const staleReplay = await worker.fetch(await signedWebhook(suspendPayload, 'installation', 'delivery-suspend-new-header'), env, { waitUntil: () => undefined });
    expect(await staleReplay.json()).toMatchObject({ accepted: false, duplicate: true });
    expect(store.registrations.get(registration.id)?.active).toBe(true);

    const staleUnsuspend = await worker.fetch(await signedWebhook(resumePayload, 'installation', 'delivery-unsuspend-new-header'), env, { waitUntil: () => undefined });
    expect(await staleUnsuspend.json()).toMatchObject({ accepted: false, duplicate: true });
    expect(store.registrations.get(registration.id)?.active).toBe(true);
  });

  it('does not persist a temporary GitHub 403 as lifecycle revocation and accepts a later authoritative denial', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    github.accessResolver = async () => { throw new GitHubClientError('github-transient-api-failure', 403, true, 20); };
    const payload = JSON.stringify({ action: 'suspend', installation: installationWebhookRecord() });
    const limited = await worker.fetch(await signedWebhook(payload, 'installation', 'rate-limited-suspend'), env, { waitUntil: () => undefined });
    expect(limited.status).toBe(503);
    expect(limited.headers.get('retry-after')).toBe('20');
    expect(store.registrations.get(registration.id)?.active).toBe(true);
    expect(store.deliveries.size).toBe(0);

    github.accessResolver = async () => ({ targetAccessible: false, targetWritable: false, upstreamReadable: false });
    const retry = await worker.fetch(await signedWebhook(payload, 'installation', 'rate-limited-suspend-retry'), env, { waitUntil: () => undefined });
    expect(retry.status).toBe(202);
    expect(store.registrations.get(registration.id)?.active).toBe(false);
    expect(store.deliveries.size).toBe(1);
  });

  it('does not let a delayed lifecycle denial overwrite a newer operator pause and approval', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    let releaseDenied: ((access: typeof github.access) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    github.accessResolver = () => new Promise(resolve => {
      releaseDenied = resolve;
      notifyStarted?.();
    });
    const suspendPayload = JSON.stringify({ action: 'suspend', installation: installationWebhookRecord() });
    const pendingWebhook = worker.fetch(await signedWebhook(suspendPayload, 'installation', 'delayed-denial'), env, { waitUntil: () => undefined });
    await started;

    const pause = await worker.fetch(new Request(`https://worker.example/admin/registrations/${registration.id}/active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false, expectedRevision: 1 }),
    }), env, { waitUntil: () => undefined });
    expect(pause.status).toBe(200);
    github.accessResolver = undefined;
    github.access = { targetAccessible: true, targetWritable: true, upstreamReadable: true };
    const approval = await worker.fetch(new Request(`https://worker.example/admin/registrations/${registration.id}/active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: true, expectedRevision: 2 }),
    }), env, { waitUntil: () => undefined });
    expect(approval.status).toBe(200);
    expect(store.registrations.get(registration.id)?.revision).toBe(3);

    releaseDenied?.({ targetAccessible: false, targetWritable: false, upstreamReadable: false });
    expect((await pendingWebhook).status).toBe(202);
    expect(store.registrations.get(registration.id)).toMatchObject({ active: true, revision: 3 });
  });

  it('deactivates a removed target repository and requires operator reactivation after it is added again', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    github.access = { targetAccessible: false, targetWritable: false, upstreamReadable: false };
    const removed = JSON.stringify({
      action: 'removed',
      installation: installationWebhookRecord(registration.installationId),
      repositories_added: [],
      repositories_removed: [{ id: 99, full_name: target.fullName }],
    });
    const removedResponse = await worker.fetch(await signedWebhook(removed, 'installation_repositories', 'delivery-repo-removed'), env, { waitUntil: () => undefined });
    expect(removedResponse.status).toBe(202);
    expect(store.registrations.get(registration.id)?.active).toBe(false);

    const added = JSON.stringify({
      action: 'added',
      installation: installationWebhookRecord(registration.installationId),
      repositories_added: [{ id: 99, full_name: target.fullName }],
      repositories_removed: [],
    });
    const addedResponse = await worker.fetch(await signedWebhook(added, 'installation_repositories', 'delivery-repo-added'), env, { waitUntil: () => undefined });
    expect(addedResponse.status).toBe(202);
    expect(store.registrations.get(registration.id)?.active).toBe(false);
  });

  it('ignores a stale signed repository-removal hint when current GitHub access still permits the target', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    const removal = JSON.stringify({
      action: 'removed',
      installation: installationWebhookRecord(registration.installationId),
      repositories_added: [],
      repositories_removed: [{ id: 99, full_name: target.fullName }],
    });
    const response = await worker.fetch(await signedWebhook(removal, 'installation_repositories', 'stale-removal'), env, { waitUntil: () => undefined });
    expect(response.status).toBe(202);
    expect(github.accessCalls).toBe(1);
    expect(store.registrations.get(registration.id)?.active).toBe(true);
  });

  it('ignores malformed repository-selection events with a nonempty opposite array', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    const payload = JSON.stringify({
      action: 'removed',
      installation: installationWebhookRecord(),
      repositories_added: [{ id: 100, full_name: 'other-org/repository' }],
      repositories_removed: [{ id: 99, full_name: target.fullName }],
    });
    const response = await worker.fetch(await signedWebhook(payload, 'installation_repositories', 'malformed-opposite-repos'), env, { waitUntil: () => undefined });
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(github.accessCalls).toBe(0);
    expect(store.registrations.get(registration.id)?.active).toBe(true);
  });

  it('does not reinterpret a signed comment payload as an installation lifecycle event', async () => {
    const { worker, env, store, queue } = setup();
    await registerSeed(store);
    const commentPayload = JSON.stringify({
      action: 'deleted',
      installation: { id: 23, account: { login: 'target-org' } },
      issue: { number: 4 },
      comment: { id: 5, body: 'ordinary user content' },
    });
    const first = await worker.fetch(await signedWebhook(commentPayload, 'issue_comment', 'comment-delivery'), env, { waitUntil: () => undefined });
    expect(first.status).toBe(202);
    const relabeled = await worker.fetch(await signedWebhook(commentPayload, 'installation', 'retagged-delivery'), env, { waitUntil: () => undefined });
    expect(await relabeled.json()).toMatchObject({ accepted: false, duplicate: true, ignored: true });
    expect(store.registrations.get('tracking_seed')?.active).toBe(true);
    expect(queue.sent).toHaveLength(0);
  });

  it('does not apply an old denial result after an authenticated operator advances the registration revision', async () => {
    const { worker, env, store, github } = setup();
    const registration = await registerSeed(store);
    let releaseDenied: ((access: typeof github.access) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    github.accessResolver = () => new Promise(resolve => {
      releaseDenied = resolve;
      notifyStarted?.();
    });
    const suspendPayload = JSON.stringify({ action: 'suspend', installation: installationWebhookRecord() });
    const pendingWebhook = worker.fetch(await signedWebhook(suspendPayload, 'installation', 'delayed-denial'), env, { waitUntil: () => undefined });
    await started;

    const pause = await worker.fetch(new Request(`https://worker.example/admin/registrations/${registration.id}/active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false, expectedRevision: 1 }),
    }), env, { waitUntil: () => undefined });
    expect(pause.status).toBe(200);
    github.accessResolver = undefined;
    github.access = { targetAccessible: true, targetWritable: true, upstreamReadable: true };
    const approval = await worker.fetch(new Request(`https://worker.example/admin/registrations/${registration.id}/active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: true, expectedRevision: 2 }),
    }), env, { waitUntil: () => undefined });
    expect(approval.status).toBe(200);
    expect(store.registrations.get(registration.id)?.revision).toBe(3);

    releaseDenied?.({ targetAccessible: false, targetWritable: false, upstreamReadable: false });
    expect((await pendingWebhook).status).toBe(202);
    expect(store.registrations.get(registration.id)).toMatchObject({ active: true, revision: 3 });
  });
});

class ReplayGuardD1 implements D1DatabaseBinding {
  readonly deliveries = new Map<string, { expiresAt: string; claim: string }>();

  prepare(query: string): D1PreparedStatementBinding {
    const values: D1SqlValue[] = [];
    const statement: D1PreparedStatementBinding = {
      bind: (...args: D1SqlValue[]) => { values.splice(0, values.length, ...args); return statement; },
      first: async <Row>(): Promise<Row | null> => {
        if (!query.includes('INSERT INTO webhook_deliveries')) return null;
        const [installationId, deliveryId, payloadDigest, payloadClass, receivedAt, expiresAt, claim] = values;
        const key = `${String(installationId)}:${String(payloadDigest)}`;
        const existing = this.deliveries.get(key);
        if (existing && (payloadClass === 'lifecycle' || Date.parse(existing.expiresAt) > Date.parse(String(receivedAt)))) return null;
        this.deliveries.set(key, { expiresAt: String(expiresAt), claim: String(claim) });
        return { payload_digest: String(payloadDigest), delivery_id: String(deliveryId) } as Row;
      },
      all: async <Row>(): Promise<D1QueryResult<Row>> => ({ success: true, results: [] }),
      run: async <Row>(): Promise<D1QueryResult<Row>> => ({ success: true, results: [], meta: { changes: 0 } }),
    };
    return statement;
  }

  async batch<Row>(): Promise<D1QueryResult<Row>[]> { return []; }
}

class SQLitePreparedStatement implements D1PreparedStatementBinding {
  private values: D1SqlValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: D1SqlValue[]): D1PreparedStatementBinding {
    this.values = values;
    return this;
  }

  async first<Row>(): Promise<Row | null> {
    const result = await this.all<Row>();
    return result.results[0] ?? null;
  }

  all<Row>(): Promise<D1QueryResult<Row>> {
    const before = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    const results = this.database.prepare(this.sql).all(...this.values);
    const after = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return Promise.resolve({
      success: true,
      results: results as unknown as Row[],
      meta: { changes: after.changes - before.changes },
    });
  }

  run<Row>(): Promise<D1QueryResult<Row>> {
    const before = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    this.database.prepare(this.sql).run(...this.values);
    const after = this.database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return Promise.resolve({ success: true, results: [], meta: { changes: after.changes - before.changes } });
  }

  async execute(): Promise<D1QueryResult<unknown>> {
    if (/\bRETURNING\b/i.test(this.sql)) return this.all<unknown>();
    return this.run<unknown>();
  }
}

class SQLiteD1 implements D1DatabaseBinding {
  readonly database = new DatabaseSync(':memory:');

  constructor() {
    const migrationUrl = new URL('../migrations/0001_initial.sql', import.meta.url);
    this.database.exec(readFileSync(migrationUrl, 'utf8'));
  }

  prepare(query: string): D1PreparedStatementBinding {
    return new SQLitePreparedStatement(this.database, query);
  }

  async batch<Row>(statements: D1PreparedStatementBinding[]): Promise<D1QueryResult<Row>[]> {
    this.database.exec('BEGIN');
    try {
      const results: D1QueryResult<Row>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof SQLitePreparedStatement)) throw new Error('Unexpected prepared statement');
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

describe('D1 control-plane storage boundary', () => {
  it('deduplicates payload fingerprints independently of the unsigned delivery header', async () => {
    const db = new ReplayGuardD1();
    const store = new D1RegistryStore(db, () => nowIso);
    const first: WebhookDelivery = {
      deliveryId: 'delivery-once',
      installationId: 23,
      receivedAt: nowIso,
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    await expect(store.recordWebhookDelivery(first)).rejects.toMatchObject({ code: 'verified-webhook-payload-required' });
    const lifecycleEvidence: WebhookPayloadEvidence = { payloadDigest: 'd'.repeat(64), payloadClass: 'lifecycle' };
    expect(await store.recordWebhookDelivery(first, lifecycleEvidence)).toBe(true);
    expect(await store.recordWebhookDelivery({ ...first, deliveryId: 'changed-unsigned-id' }, lifecycleEvidence)).toBe(false);
    const expiredReplay = {
      ...first,
      receivedAt: new Date(nowMs + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(nowMs + 61 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    expect(await store.recordWebhookDelivery(expiredReplay, lifecycleEvidence)).toBe(false);
    const ordinaryEvidence: WebhookPayloadEvidence = { payloadDigest: 'e'.repeat(64), payloadClass: 'event' };
    expect(await store.recordWebhookDelivery(first, ordinaryEvidence)).toBe(true);
    expect(await store.recordWebhookDelivery({ ...expiredReplay, deliveryId: 'new-header' }, ordinaryEvidence)).toBe(true);
  });

  it('uses the installed SQLite schema for baseline creation, due scheduling, and identity-only outbox work', async () => {
    const db = new SQLiteD1();
    db.database.prepare('INSERT INTO installations (installation_id, status, account_login, updated_at) VALUES (?, ?, ?, ?)')
      .run(23, 'active', 'target-org', nowIso);
    db.database.prepare('INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(23, target.fullName.toLowerCase(), 99, 1, nowIso);
    const policy = parsePolicy(rawPolicy());
    const digest = await policyHash(policy);
    const store = new D1RegistryStore(db, () => nowIso);
    const registration = await store.createTrackingRegistration({
      id: 'tracking_sqlite',
      installationId: 23,
      target,
      baseBranch: 'main',
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
      policy,
      policyHash: digest,
      active: true,
    });
    expect(registration.lastCheckedCommit).toBe(baseline);
    expect(registration.lastSyncedCommit).toBe(baseline);

    const nextDueAt = new Date(nowMs + 300_000).toISOString();
    expect(await store.enqueueDuePolls({ now: nowIso, nextDueAt, limit: 100 })).toBe(1);
    expect(await store.enqueueDuePolls({ now: nowIso, nextDueAt, limit: 100 })).toBe(0);
    const pending = await store.listPendingOutbox({ now: nowIso, limit: 10 });
    expect(pending).toEqual([{ workId: `poll:tracking_sqlite:${nowIso}`, kind: 'poll', trackingId: 'tracking_sqlite', attempts: 0 }]);

    const staleSuspensionDelivery: WebhookDelivery = {
      deliveryId: 'sqlite-stale-suspend',
      installationId: 23,
      receivedAt: nowIso,
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    expect(await store.applyInstallationWebhook({
      delivery: staleSuspensionDelivery,
      evidence: { payloadDigest: 'a'.repeat(64), payloadClass: 'lifecycle' },
      action: 'suspend',
      repositories: [],
      confirmedInaccessibleTrackingIds: [],
    })).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(true);
    expect(await store.applyInstallationWebhook({
      delivery: { ...staleSuspensionDelivery, deliveryId: 'sqlite-stale-suspend-retag' },
      evidence: { payloadDigest: 'a'.repeat(64), payloadClass: 'lifecycle' },
      action: 'suspend',
      repositories: [],
      confirmedInaccessibleTrackingIds: [{ trackingId: registration.id, expectedRevision: 1 }],
    })).toBe(false);
    expect(await store.isTrackingEligible(registration.id)).toBe(true);
    expect(await store.advanceLastCheckedCommit({
      trackingId: registration.id,
      expectedLastCheckedCommit: baseline,
      nextLastCheckedCommit: 'b'.repeat(40),
      policyHash: registration.policyHash,
    })).toBe(true);
    expect((await store.getTrackingRegistration(registration.id))?.revision).toBe(2);

    const delayedDenialDelivery: WebhookDelivery = {
      ...staleSuspensionDelivery,
      deliveryId: 'sqlite-delayed-suspend',
      receivedAt: new Date(nowMs + 1_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000 + 1_000).toISOString(),
    };
    expect(await store.applyInstallationWebhook({
      delivery: delayedDenialDelivery,
      evidence: { payloadDigest: 'f'.repeat(64), payloadClass: 'lifecycle' },
      action: 'suspend',
      repositories: [],
      confirmedInaccessibleTrackingIds: [{ trackingId: registration.id, expectedRevision: 1 }],
    })).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(true);
    expect((await store.getTrackingRegistration(registration.id))?.revision).toBe(2);

    const confirmedSuspensionDelivery: WebhookDelivery = {
      ...delayedDenialDelivery,
      deliveryId: 'sqlite-confirmed-suspend',
      receivedAt: new Date(nowMs + 2_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000 + 2_000).toISOString(),
    };
    expect(await store.applyInstallationWebhook({
      delivery: confirmedSuspensionDelivery,
      evidence: { payloadDigest: '7'.repeat(64), payloadClass: 'lifecycle' },
      action: 'suspend',
      repositories: [],
      confirmedInaccessibleTrackingIds: [{ trackingId: registration.id, expectedRevision: 2 }],
    })).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(false);
    expect(await store.setTrackingRegistrationActive({ trackingId: registration.id, expectedRevision: 3, active: true })).toBe(true);
    expect((await store.getTrackingRegistration(registration.id))?.revision).toBe(4);

    const staleRemovalDelivery: WebhookDelivery = {
      deliveryId: 'sqlite-stale-repo-removed',
      installationId: 23,
      receivedAt: new Date(nowMs + 3_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000 + 3_000).toISOString(),
    };
    const lifecycleEvidence: WebhookPayloadEvidence = { payloadDigest: 'b'.repeat(64), payloadClass: 'lifecycle' };
    expect(await store.applyInstallationRepositoriesWebhook({
      delivery: staleRemovalDelivery,
      evidence: lifecycleEvidence,
      added: [],
      removed: [target.fullName],
      confirmedRemovedTrackingIds: [{ trackingId: registration.id, expectedRevision: 3 }],
    })).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(true);
    expect((await store.getTrackingRegistration(registration.id))?.revision).toBe(4);

    const confirmedRemovalDelivery: WebhookDelivery = {
      ...staleRemovalDelivery,
      deliveryId: 'sqlite-confirmed-repo-removed',
      receivedAt: new Date(nowMs + 4_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000 + 4_000).toISOString(),
    };
    expect(await store.applyInstallationRepositoriesWebhook({
      delivery: confirmedRemovalDelivery,
      evidence: { payloadDigest: '8'.repeat(64), payloadClass: 'lifecycle' },
      added: [],
      removed: [target.fullName],
      confirmedRemovedTrackingIds: [{ trackingId: registration.id, expectedRevision: 4 }],
    })).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(false);
    expect((await store.getTrackingRegistration(registration.id))?.revision).toBe(5);

    const additionDelivery: WebhookDelivery = {
      ...confirmedRemovalDelivery,
      deliveryId: 'sqlite-repo-added',
      receivedAt: new Date(nowMs + 5_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000 + 5_000).toISOString(),
    };
    expect(await store.applyInstallationRepositoriesWebhook({
      delivery: additionDelivery,
      evidence: { payloadDigest: '9'.repeat(64), payloadClass: 'lifecycle' },
      added: [{ fullName: target.fullName, repositoryId: 99 }],
      removed: [],
      confirmedRemovedTrackingIds: [],
    })).toBe(true);
    expect((await store.getTrackingRegistration(registration.id))?.active).toBe(false);
    expect(await store.isTrackingEligible(registration.id)).toBe(false);
    db.database.close();
  });

  it('treats installation/repository webhooks as unverified hints until authenticated registration preflight', async () => {
    const db = new SQLiteD1();
    const store = new D1RegistryStore(db, () => nowIso);
    const delivery: WebhookDelivery = {
      deliveryId: 'sqlite-install-created',
      installationId: 25,
      receivedAt: nowIso,
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    expect(await store.applyInstallationWebhook({
      delivery,
      evidence: { payloadDigest: '9'.repeat(64), payloadClass: 'lifecycle' },
      action: 'created',
      accountLogin: 'target-org',
      repositories: [{ fullName: target.fullName, repositoryId: 101 }],
      confirmedInaccessibleTrackingIds: [],
    })).toBe(true);
    const unverified = db.database.prepare('SELECT status FROM installations WHERE installation_id = ?').get(25) as { status: string };
    const hintedRepository = db.database.prepare('SELECT active FROM installation_repositories WHERE installation_id = ?').get(25) as { active: number };
    expect(unverified.status).toBe('unverified');
    expect(hintedRepository.active).toBe(0);
    expect(await store.applyInstallationWebhook({
      delivery: { ...delivery, deliveryId: 'sqlite-install-created-retagged' },
      evidence: { payloadDigest: '9'.repeat(64), payloadClass: 'lifecycle' },
      action: 'created',
      accountLogin: 'target-org',
      repositories: [],
      confirmedInaccessibleTrackingIds: [],
    })).toBe(false);

    const policy = parsePolicy(rawPolicy());
    const registration = await store.createTrackingRegistration({
      id: 'tracking_after_preflight',
      installationId: 25,
      target,
      baseBranch: 'main',
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
      policy,
      policyHash: await policyHash(policy),
      active: true,
    });
    expect(registration.active).toBe(true);
    expect(await store.isTrackingEligible(registration.id)).toBe(true);
    const verified = db.database.prepare('SELECT status FROM installations WHERE installation_id = ?').get(25) as { status: string };
    expect(verified.status).toBe('active');
    db.database.close();
  });
});

async function pushSetup() {
  const db = new SQLiteD1();
  db.database.prepare('INSERT INTO installations (installation_id, status, account_login, updated_at) VALUES (?, ?, ?, ?)')
    .run(23, 'active', 'target-org', nowIso);
  db.database.prepare('INSERT INTO installation_repositories (installation_id, full_name, repository_id, active, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(23, target.fullName.toLowerCase(), 99, 1, nowIso);
  const store = new D1RegistryStore(db, () => nowIso);
  const policy = parsePolicy(rawPolicy());
  const digest = await policyHash(policy);
  for (const [id, baseBranch, active] of [['tracking_main', 'main', true], ['tracking_paused', 'release', false]] as const) {
    await store.createTrackingRegistration({
      id,
      installationId: 23,
      target,
      baseBranch,
      upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: baseline },
      policy,
      policyHash: digest,
      active,
    });
  }
  const queue = new FakeQueue();
  const durableObject = new FakeDurableObject();
  const env: Env = {
    DB: db,
    JOB_QUEUE: queue,
    TARGET_JOBS: { getByName: () => durableObject },
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY: 'private-key-held-by-worker',
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    ADMIN_TOKEN: adminToken,
  };
  const clock = { now: nowMs };
  const dependencies: WorkerDependencies = {
    storeFor: () => store,
    githubFor: () => new FakeGitHub(),
    queueFor: () => queue,
    targetJobsFor: () => env.TARGET_JOBS,
    now: () => clock.now,
  };
  const worker = createWorker(dependencies);
  const push = async (fields: Record<string, unknown>, deliveryId: string, event = 'push') => {
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      before: 'b'.repeat(40),
      after: 'c'.repeat(40),
      deleted: false,
      installation: { id: 23, node_id: 'MDIzOkluc3RhbGxhdGlvbjIz' },
      repository: { full_name: 'Upstream-Org/Project' },
      ...fields,
    });
    return worker.fetch(await signedWebhook(payload, event, deliveryId), env, { waitUntil: () => undefined });
  };
  return { db, store, queue, env, dependencies, clock, push };
}

const pushPoll = (trackingId: string) => ({
  version: 1,
  workId: expect.stringMatching(new RegExp(`^hook_[a-f0-9]{64}:${trackingId}$`)),
  kind: 'poll',
  trackingId,
});

describe('upstream push webhooks', () => {
  it('sends one poll for the active registration tracking the pushed upstream branch', async () => {
    const { db, queue, push } = await pushSetup();
    const response = await push({}, 'push-main');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it('enqueues when the upstream is covered by a different installation than the registration', async () => {
    const { db, queue, push } = await pushSetup();
    const response = await push({ installation: { id: 77, node_id: 'MDIzOkluc3RhbGxhdGlvbjc3' } }, 'push-other-installation');
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it.each(['refs/heads/main', 'refs/tags/v1.0.0'])('does not enqueue a replayed %s delivery a second time', async ref => {
    const { db, queue, push } = await pushSetup();
    await push({ ref }, 'push-replay');
    const replay = await push({ ref }, 'push-replay');
    expect(await replay.json()).toEqual({ accepted: false, duplicate: true });
    const retagged = await push({ ref }, 'push-replay-new-header');
    expect(await retagged.json()).toEqual({ accepted: false, duplicate: true });
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it('ignores pushes to other branches and branch/tag deletions', async () => {
    const { db, queue, push } = await pushSetup();
    for (const [fields, deliveryId] of [
      [{ ref: 'refs/heads/develop' }, 'push-other-branch'],
      [{ ref: 'refs/tags/v1.0.0', deleted: true, after: '0'.repeat(40) }, 'push-tag-deleted'],
      [{ deleted: true, after: '0'.repeat(40) }, 'push-branch-deleted'],
    ] as const) {
      const response = await push(fields, deliveryId);
      expect(response.status).toBe(202);
    }
    expect(queue.sent).toEqual([]);
    await push({}, 'push-control');
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it('uses tag pushes to wake all eligible stored branches across installations, without adopting the tag SHA', async () => {
    const { db, store, queue, push } = await pushSetup();
    const main = await store.getTrackingRegistration('tracking_main');
    if (!main) throw new Error('missing fixture registration');
    for (const [id, installationId, upstream, active] of [
      ['tracking_release', 77, { repository: upstreamRepository, ref: 'release' }, true],
      ['tracking_other_repo', 23, { repository: 'https://github.com/other/project.git', ref: 'main' }, true],
      ['tracking_suspended', 88, { repository: upstreamRepository, ref: 'main' }, true],
      ['tracking_removed', 99, { repository: upstreamRepository, ref: 'main' }, true],
    ] as const) {
      const policy = parsePolicy({ ...rawPolicy(), upstream });
      await store.createTrackingRegistration({
        id, installationId, target, baseBranch: id, upstream: { ...upstream, baselineCommit: baseline },
        policy, policyHash: await policyHash(policy), active,
      });
    }
    db.database.prepare("UPDATE installations SET status = 'suspended' WHERE installation_id = 88").run();
    db.database.prepare('UPDATE installation_repositories SET active = 0 WHERE installation_id = 99').run();
    const response = await push({ ref: 'refs/tags/releases/v1.0.0', installation: { id: 1234 }, after: 'e'.repeat(40) }, 'tag-wake');
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent).toEqual(expect.arrayContaining([pushPoll('tracking_main'), pushPoll('tracking_release')]));
    expect(await store.getTrackingRegistration('tracking_main')).toEqual(main);
    expect(await store.getTrackingRegistration('tracking_release')).toMatchObject({
      upstream: { repository: upstreamRepository, ref: 'release', baselineCommit: baseline },
      lastCheckedCommit: baseline, lastSyncedCommit: baseline,
    });
    const due = db.database.prepare('SELECT next_due_at FROM tracking_schedules WHERE tracking_id = ?').get('tracking_release') as { next_due_at: string };
    expect(due.next_due_at).toBe(new Date(nowMs + 24 * 60 * 60_000).toISOString());
    queue.sent.length = 0;
    await push({ ref: 'refs/heads/release', after: 'f'.repeat(64) }, 'release-branch');
    expect(queue.sent).toEqual([pushPoll('tracking_release')]);
    db.database.close();
  });

  it.each([
    { ref: 'refs/tags/' }, { ref: 'refs/tags/.hidden' }, { ref: 'refs/tags/v1.lock' },
    { ref: 'refs/tags/a/../b' }, { ref: 'refs/tags/a//b' }, { ref: 'refs/tags/a b' },
    { ref: 'refs/heads/main.lock' }, { ref: 'refs/pull/1/head' },
    { after: 'not-a-sha' }, { after: '0'.repeat(40) }, { ref: 'refs/tags/v1', after: '0'.repeat(64) },
  ])('rejects invalid nondeleted push $ref $after without enqueuing', async fields => {
    const { db, queue, push } = await pushSetup();
    const response = await push(fields, 'invalid-push');
    expect(response.status).toBe(400);
    expect(queue.sent).toEqual([]);
    expect(db.database.prepare('SELECT * FROM queue_outbox').all()).toEqual([]);
    db.database.close();
  });

  it('binds signed tag bodies to push events even when delivery/event headers change', async () => {
    const { db, queue, push } = await pushSetup();
    const fields = { ref: 'refs/tags/v2' };
    const wrongEvent = await push(fields, 'tag-wrong-event', 'installation');
    expect(await wrongEvent.json()).toMatchObject({ accepted: true, ignored: true });
    expect(queue.sent).toEqual([]);
    const replay = await push(fields, 'tag-new-event-header');
    expect(await replay.json()).toEqual({ accepted: false, duplicate: true });
    expect(queue.sent).toEqual([]);
    await push({ ref: 'refs/tags/v3' }, 'tag-valid');
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it('persists tag wake-up work through queue failure and retries the same identity-only outbox item', async () => {
    const { db, queue, clock, push } = await pushSetup();
    queue.fail = true;
    const response = await push({ ref: 'refs/tags/v1' }, 'tag-queue-failure');
    expect(response.status).toBe(202);
    const pending = db.database.prepare('SELECT * FROM queue_outbox').all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tracking_id: 'tracking_main', status: 'pending', attempts: 1 });
    queue.fail = false;
    clock.now += 60_000;
    await flushQueueOutbox({ store: new D1RegistryStore(db, () => nowIso), queue, now: () => clock.now, limit: 100 });
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    expect(db.database.prepare('SELECT status FROM queue_outbox').get()).toMatchObject({ status: 'sent' });
    db.database.close();
  });

  it.each(['refs/heads/main', 'refs/tags/v1'])('ignores %s pushes to repositories that no registration tracks', async ref => {
    const { db, queue, push } = await pushSetup();
    const response = await push({ ref, repository: { full_name: 'someone-else/project' } }, 'push-untracked');
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
    expect(queue.sent).toEqual([]);
    await push({}, 'push-control');
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it('does not enqueue an inactive registration', async () => {
    const { db, store, queue, push } = await pushSetup();
    expect(await store.setTrackingRegistrationActive({ trackingId: 'tracking_main', expectedRevision: 1, active: false })).toBe(true);
    await push({}, 'push-while-paused');
    expect(queue.sent).toEqual([]);
    expect(await store.setTrackingRegistrationActive({ trackingId: 'tracking_main', expectedRevision: 2, active: true })).toBe(true);
    await push({ after: 'd'.repeat(40) }, 'push-after-resume');
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    db.database.close();
  });

  it.each(['refs/heads/main', 'refs/tags/v1'])('postpones the fallback poll of a %s-triggered registration by the fallback interval', async ref => {
    const { db, queue, env, dependencies, clock, push } = await pushSetup();
    await push({ ref }, 'push-postpones-fallback');
    await runScheduler(env, dependencies);
    expect(queue.sent).toEqual([pushPoll('tracking_main')]);
    clock.now = nowMs + 24 * 60 * 60 * 1_000;
    await runScheduler(env, dependencies);
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[1]).toEqual({
      version: 1,
      workId: `poll:tracking_main:${new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString()}`,
      kind: 'poll',
      trackingId: 'tracking_main',
    });
    db.database.close();
  });
});
