import type { NewTrackingRegistration, TrackingId, TrackingRegistration, WebhookDelivery } from './contracts.js';
import {
  GitHubAppClient,
  GitHubClientError,
  parseVerifiedWebhookJson,
  readBoundedRequestBody,
  verifyGitHubWebhookSignature,
  type RegistrationGitHubPort,
} from './github.js';
import { parsePolicy, policyHash } from './policy.js';
import {
  D1RegistryStore,
  StoreError,
  flushQueueOutbox,
  type InstallationRepositoriesWebhookUpdate,
  type InstallationRepositoryRecord,
  type InstallationWebhookUpdate,
  type PullRequestWebhookUpdate,
  type QueueOutboxRecord,
  type QueueWorkMessage,
  type TrackingStorePort,
  type UpstreamPushWebhookUpdate,
  type WebhookPayloadEvidence,
  type ConfirmedRegistrationRevision,
} from './store.js';
import type {
  Env,
  ExecutionContextBinding,
  QueueBatchBinding,
  ScheduledEventBinding,
  TargetJobRpc,
} from './env.js';

const WEBHOOK_BODY_MAX_BYTES = 1_000_000;
const ADMIN_BODY_MAX_BYTES = 1_000_000;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const FALLBACK_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SCHEDULER_BATCH_SIZE = 100;
const OUTBOX_FLUSH_SIZE = 100;
const MAX_LIFECYCLE_REGISTRATIONS = 50;
const MAX_LIFECYCLE_RECONCILE_SECONDS = 25;
const MAX_ACTIVE_REGISTRATION_SCAN = 5_000;

interface ControlPlaneStore extends TrackingStorePort {
  isTrackingEligible(trackingId: TrackingId): Promise<boolean>;
  applyInstallationWebhook(input: InstallationWebhookUpdate): Promise<boolean>;
  applyInstallationRepositoriesWebhook(input: InstallationRepositoriesWebhookUpdate): Promise<boolean>;
  enqueueMergedPullRequestReconciliation(input: PullRequestWebhookUpdate): Promise<boolean>;
  enqueueUpstreamPushPolls(input: UpstreamPushWebhookUpdate): Promise<boolean>;
  enqueueWork(input: {
    workId: string;
    kind: QueueWorkMessage['kind'];
    trackingId: TrackingId;
    createdAt: string;
  }): Promise<boolean>;
  enqueueDuePolls(input: { now: string; nextDueAt: string; limit: number }): Promise<number>;
  listPendingOutbox(input: { now: string; limit: number }): Promise<readonly QueueOutboxRecord[]>;
  markOutboxSent(workId: string, sentAt: string): Promise<boolean>;
  markOutboxRetry(workId: string, nextAttemptAt: string): Promise<boolean>;
  pruneExpiredRecords(input: { now: string; limit: number }): Promise<void>;
  recordWebhookDelivery(input: WebhookDelivery, evidence?: WebhookPayloadEvidence): Promise<boolean>;
}

export interface WorkerDependencies {
  storeFor(env: Env): ControlPlaneStore;
  githubFor(env: Env): RegistrationGitHubPort;
  queueFor(env: Env): { send(message: QueueWorkMessage): Promise<void> };
  targetJobsFor(env: Env): { getByName(name: string): TargetJobRpc };
  now?: () => number;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'HttpError';
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], code: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new HttpError(400, code);
  }
}

function text(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, code);
  }
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, code);
  return value;
}

function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function validBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith('-') && !value.startsWith('/')
    && !value.endsWith('/') && !value.endsWith('.') && !value.includes('..') && !value.includes('@{')
    && !value.includes('//') && !/[ ~^:?*\[\\\x00-\x20\x7f]/.test(value);
}

async function parseJsonBytes(bytes: Uint8Array): Promise<unknown> {
  let textValue: string;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'invalid-utf8-body');
  }
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    throw new HttpError(400, 'invalid-json-body');
  }
}

async function constantTimeTokenMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(leftDigest);
  const right = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0 && expected.length > 0;
}

async function isAdmin(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.length > 4_096) return false;
  const match = authorization.match(/^Bearer (.{1,4000})$/);
  return constantTimeTokenMatch(match?.[1] ?? '', expectedToken);
}

function installationIdFromPayload(payload: Record<string, unknown>): number | undefined {
  const installation = payload.installation;
  if (!isRecord(installation) || typeof installation.id !== 'number'
    || !Number.isSafeInteger(installation.id) || installation.id < 1) return undefined;
  return installation.id;
}

function loginFromInstallation(payload: Record<string, unknown>): string | undefined {
  if (!isRecord(payload.installation) || !isRecord(payload.installation.account)) return undefined;
  const login = payload.installation.account.login;
  return typeof login === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(login) ? login : undefined;
}

function installationRepositoryList(value: unknown): InstallationRepositoryRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'invalid-installation-repositories');
  return value.map(item => {
    if (!isRecord(item) || typeof item.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.full_name)) {
      throw new HttpError(400, 'invalid-installation-repository');
    }
    const repositoryId = item.id;
    if (repositoryId !== undefined && (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1)) {
      throw new HttpError(400, 'invalid-installation-repository');
    }
    return { fullName: item.full_name, ...(typeof repositoryId === 'number' ? { repositoryId } : {}) };
  });
}

function removedRepositoryList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'invalid-installation-repositories');
  return value.map(item => {
    if (!isRecord(item) || typeof item.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.full_name)) {
      throw new HttpError(400, 'invalid-installation-repository');
    }
    return item.full_name;
  });
}

function makeWebhookDelivery(deliveryHint: string | null, payloadDigest: string, installationId: number, now: number): WebhookDelivery {
  const deliveryId = deliveryHint && /^[A-Za-z0-9._:-]{1,200}$/.test(deliveryHint)
    ? deliveryHint
    : `body_${payloadDigest}`;
  const receivedAt = new Date(now).toISOString();
  return {
    deliveryId,
    installationId,
    receivedAt,
    expiresAt: new Date(now + DELIVERY_RETENTION_MS).toISOString(),
  };
}

async function hashWorkPrefix(installationId: number, deliveryId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${installationId}\u0000${deliveryId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `hook_${hex}`;
}

type SignedWebhookKind = 'installation' | 'installation_repositories' | 'pull_request' | 'push' | 'other';

function isSignedInstallationEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1
    || !isRecord(value.account) || typeof value.account.login !== 'string'
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.account.login)
    || (value.account.type !== 'User' && value.account.type !== 'Organization')
    || typeof value.app_id !== 'number' || !Number.isSafeInteger(value.app_id) || value.app_id < 1
    || typeof value.target_id !== 'number' || !Number.isSafeInteger(value.target_id) || value.target_id < 1
    || (value.target_type !== 'User' && value.target_type !== 'Organization')
    || (value.repository_selection !== 'all' && value.repository_selection !== 'selected')
    || !isRecord(value.permissions) || !Array.isArray(value.events)
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) return false;
  return true;
}

function signedWebhookKind(payload: Record<string, unknown>): SignedWebhookKind {
  if (isRecord(payload.pull_request) && isRecord(payload.repository)
    && typeof payload.repository.full_name === 'string'
    && typeof payload.pull_request.number === 'number' && Number.isSafeInteger(payload.pull_request.number)
    && isRecord(payload.pull_request.base) && typeof payload.pull_request.base.ref === 'string'
    && typeof payload.action === 'string'
    && !Object.hasOwn(payload, 'issue') && !Object.hasOwn(payload, 'comment')) return 'pull_request';
  if (isRecord(payload.repository) && typeof payload.repository.full_name === 'string'
    && typeof payload.ref === 'string' && typeof payload.after === 'string'
    && !Object.hasOwn(payload, 'pull_request') && !Object.hasOwn(payload, 'issue')
    && !Object.hasOwn(payload, 'comment')) return 'push';
  const installation = payload.installation;
  if (!isSignedInstallationEnvelope(installation)
    || Object.hasOwn(payload, 'issue') || Object.hasOwn(payload, 'comment') || Object.hasOwn(payload, 'pull_request')
    || Object.hasOwn(payload, 'repository')) return 'other';
  if (Object.hasOwn(payload, 'repositories_added') || Object.hasOwn(payload, 'repositories_removed')) {
    if (payload.action === 'added' && Array.isArray(payload.repositories_added)
      && Array.isArray(payload.repositories_removed) && payload.repositories_removed.length === 0) return 'installation_repositories';
    if (payload.action === 'removed' && Array.isArray(payload.repositories_removed)
      && Array.isArray(payload.repositories_added) && payload.repositories_added.length === 0) return 'installation_repositories';
    return 'other';
  }
  if (typeof payload.action === 'string'
    && ['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'].includes(payload.action)) return 'installation';
  return 'other';
}

function payloadEvidence(payloadDigest: string, kind: SignedWebhookKind): WebhookPayloadEvidence {
  return {
    payloadDigest,
    payloadClass: kind === 'installation' || kind === 'installation_repositories' ? 'lifecycle' : 'event',
  };
}

async function digestRawPayload(body: Uint8Array): Promise<string> {
  const owned = new Uint8Array(body.byteLength);
  owned.set(body);
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function activeRegistrationsForInstallation(
  store: ControlPlaneStore,
  installationId: number,
  fullName?: string,
): Promise<TrackingRegistration[]> {
  const registrations: TrackingRegistration[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await store.listActiveTrackingRegistrations({ limit: 500, ...(cursor ? { cursor } : {}) });
    scanned += page.registrations.length;
    if (scanned > MAX_ACTIVE_REGISTRATION_SCAN) throw new HttpError(503, 'installation-reconciliation-scan-limit');
    for (const registration of page.registrations) {
      if (registration.installationId === installationId
        && (!fullName || registration.target.fullName.toLowerCase() === fullName.toLowerCase())) {
        registrations.push(registration);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (registrations.length > MAX_LIFECYCLE_REGISTRATIONS) throw new HttpError(503, 'installation-reconciliation-limit');
  return registrations;
}

async function confirmInaccessibleRegistrations(
  registrations: readonly TrackingRegistration[],
  github: RegistrationGitHubPort,
): Promise<ConfirmedRegistrationRevision[]> {
  const started = performance.now();
  const inaccessible: ConfirmedRegistrationRevision[] = [];
  for (const registration of registrations) {
    const expectedRevision = registration.revision;
    if (performance.now() - started > MAX_LIFECYCLE_RECONCILE_SECONDS * 1_000) {
      throw new HttpError(503, 'installation-reconciliation-time-limit');
    }
    const access = await github.verifyTrackingAccess({
      installationId: registration.installationId,
      target: registration.target,
      upstreamRepository: registration.upstream.repository,
    });
    if (!access.targetAccessible || !access.targetWritable) {
      inaccessible.push({ trackingId: registration.id, expectedRevision });
    }
  }
  return inaccessible;
}

async function handleVerifiedWebhook(request: Request, env: Env, dependencies: WorkerDependencies): Promise<Response> {
  const now = dependencies.now ?? Date.now;
  let body: Uint8Array;
  try {
    body = await readBoundedRequestBody(request, WEBHOOK_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof GitHubClientError && error.code === 'webhook-body-limit') throw new HttpError(413, 'body-too-large');
    throw error;
  }
  if (!await verifyGitHubWebhookSignature(body, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET)) {
    throw new HttpError(401, 'invalid-webhook-signature');
  }
  const parsed = parseVerifiedWebhookJson(body);
  if (!isRecord(parsed)) throw new HttpError(400, 'invalid-webhook-payload');
  const bodyDigest = await digestRawPayload(body);
  const kind = signedWebhookKind(parsed);
  const evidence = payloadEvidence(bodyDigest, kind);
  const eventName = request.headers.get('x-github-event');
  const installationId = installationIdFromPayload(parsed);
  if (installationId === undefined) return jsonResponse({ accepted: false, ignored: true }, 202);
  const delivery = makeWebhookDelivery(request.headers.get('x-github-delivery'), bodyDigest, installationId, now());
  const store = dependencies.storeFor(env);
  const github = dependencies.githubFor(env);

  if (eventName !== kind) {
    const accepted = await store.recordWebhookDelivery(delivery, evidence);
    return jsonResponse({ accepted, duplicate: !accepted, ignored: true }, 202);
  }

  if (kind === 'installation') {
    const action = parsed.action;
    if (typeof action !== 'string') throw new HttpError(400, 'invalid-installation-action');
    if (action === 'created' || action === 'deleted' || action === 'suspend'
      || action === 'unsuspend' || action === 'new_permissions_accepted') {
      const accountLogin = loginFromInstallation(parsed);
      const affected = action === 'suspend' || action === 'deleted' || action === 'new_permissions_accepted'
        ? await activeRegistrationsForInstallation(store, installationId)
        : [];
      const confirmedInaccessibleTrackingIds = affected.length > 0
        ? await confirmInaccessibleRegistrations(affected, github)
        : [];
      const update: InstallationWebhookUpdate = {
        delivery,
        evidence,
        ...(accountLogin ? { accountLogin } : {}),
        action,
        repositories: action === 'created' ? installationRepositoryList(parsed.repositories) : [],
        confirmedInaccessibleTrackingIds,
      };
      const accepted = await store.applyInstallationWebhook(update);
      return jsonResponse({ accepted, duplicate: !accepted }, 202);
    }
    const accepted = await store.recordWebhookDelivery(delivery, evidence);
    return jsonResponse({ accepted, duplicate: !accepted }, 202);
  }

  if (kind === 'installation_repositories') {
    const action = parsed.action;
    if (action !== 'added' && action !== 'removed') {
      const accepted = await store.recordWebhookDelivery(delivery, evidence);
      return jsonResponse({ accepted, duplicate: !accepted }, 202);
    }
    const removed = action === 'removed' ? removedRepositoryList(parsed.repositories_removed) : [];
    const removedNames = new Set(removed.map(fullName => fullName.toLowerCase()));
    const affected = removed.length > 0
      ? (await activeRegistrationsForInstallation(store, installationId)).filter(registration => removedNames.has(registration.target.fullName.toLowerCase()))
      : [];
    const confirmedRemovedTrackingIds = affected.length > 0
      ? await confirmInaccessibleRegistrations(affected, github)
      : [];
    const update: InstallationRepositoriesWebhookUpdate = {
      delivery,
      evidence,
      added: action === 'added' ? installationRepositoryList(parsed.repositories_added) : [],
      removed,
      confirmedRemovedTrackingIds,
    };
    const accepted = await store.applyInstallationRepositoriesWebhook(update);
    return jsonResponse({ accepted, duplicate: !accepted }, 202);
  }

  if (kind === 'pull_request' && eventName === 'pull_request' && parsed.action === 'closed' && isRecord(parsed.pull_request)
    && parsed.pull_request.merged === true && isRecord(parsed.repository)) {
    const repositoryFullName = text(parsed.repository.full_name, 500, 'invalid-pull-request-repository');
    const base = parsed.pull_request.base;
    if (!isRecord(base)) throw new HttpError(400, 'invalid-pull-request-base');
    const baseBranch = text(base.ref, 255, 'invalid-pull-request-base');
    if (!validBranch(baseBranch)) throw new HttpError(400, 'invalid-pull-request-base');
    const update: PullRequestWebhookUpdate = {
      delivery,
      evidence,
      repositoryFullName,
      baseBranch,
      workPrefix: await hashWorkPrefix(installationId, delivery.deliveryId),
    };
    const accepted = await store.enqueueMergedPullRequestReconciliation(update);
    if (accepted) await flushQueueOutbox({ store, queue: dependencies.queueFor(env), now, limit: OUTBOX_FLUSH_SIZE });
    return jsonResponse({ accepted, duplicate: !accepted }, 202);
  }

  if (kind === 'push' && eventName === 'push' && typeof parsed.ref === 'string' && parsed.ref.startsWith('refs/heads/')
    && parsed.deleted !== true && isRecord(parsed.repository)) {
    const repositoryFullName = text(parsed.repository.full_name, 500, 'invalid-push-repository');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) throw new HttpError(400, 'invalid-push-repository');
    const upstreamRef = text(parsed.ref.slice('refs/heads/'.length), 255, 'invalid-push-ref');
    if (!validBranch(upstreamRef)) throw new HttpError(400, 'invalid-push-ref');
    const update: UpstreamPushWebhookUpdate = {
      delivery,
      evidence,
      upstreamRepository: `https://github.com/${repositoryFullName}.git`,
      upstreamRef,
      workPrefix: await hashWorkPrefix(installationId, delivery.deliveryId),
      nextDueAt: new Date(Date.parse(delivery.receivedAt) + FALLBACK_POLL_INTERVAL_MS).toISOString(),
    };
    const accepted = await store.enqueueUpstreamPushPolls(update);
    if (accepted) await flushQueueOutbox({ store, queue: dependencies.queueFor(env), now, limit: OUTBOX_FLUSH_SIZE });
    return jsonResponse({ accepted, duplicate: !accepted }, 202);
  }

  const accepted = await store.recordWebhookDelivery(delivery, evidence);
  return jsonResponse({ accepted, duplicate: !accepted }, 202);
}

function parseRegistrationBody(value: unknown): Omit<NewTrackingRegistration, 'id' | 'active' | 'policyHash'> {
  if (!isRecord(value)) throw new HttpError(400, 'invalid-registration');
  exactKeys(value, ['installationId', 'target', 'baseBranch', 'upstream', 'policy'],
    ['installationId', 'target', 'baseBranch', 'upstream', 'policy'], 'invalid-registration');
  const installationId = positiveInteger(value.installationId, 'invalid-installation-id');
  if (!isRecord(value.target)) throw new HttpError(400, 'invalid-target-repository');
  exactKeys(value.target, ['owner', 'name'], ['owner', 'name'], 'invalid-target-repository');
  const owner = text(value.target.owner, 100, 'invalid-target-repository');
  const name = text(value.target.name, 100, 'invalid-target-repository');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(400, 'invalid-target-repository');
  const target = { owner, name, fullName: `${owner}/${name}` };
  const baseBranch = text(value.baseBranch, 255, 'invalid-base-branch');
  if (!validBranch(baseBranch)) throw new HttpError(400, 'invalid-base-branch');
  if (!isRecord(value.upstream)) throw new HttpError(400, 'invalid-upstream');
  exactKeys(value.upstream, ['repository', 'ref', 'baselineCommit'], ['repository', 'ref', 'baselineCommit'], 'invalid-upstream');
  const upstreamRepository = text(value.upstream.repository, 2_048, 'invalid-upstream');
  const upstreamRef = text(value.upstream.ref, 255, 'invalid-upstream');
  const baselineCommit = value.upstream.baselineCommit;
  if (!validCommit(baselineCommit)) throw new HttpError(400, 'invalid-upstream-baseline');
  let policy;
  try {
    policy = parsePolicy(value.policy);
  } catch {
    throw new HttpError(400, 'invalid-policy');
  }
  if (policy.upstream.repository !== upstreamRepository || policy.upstream.ref !== upstreamRef) {
    throw new HttpError(400, 'upstream-policy-mismatch');
  }
  return {
    installationId,
    target,
    baseBranch,
    upstream: { repository: upstreamRepository, ref: upstreamRef, baselineCommit },
    policy,
  };
}

async function parseAdminJson(request: Request): Promise<unknown> {
  try {
    return await parseJsonBytes(await readBoundedRequestBody(request, ADMIN_BODY_MAX_BYTES));
  } catch (error) {
    if (error instanceof GitHubClientError && error.code === 'webhook-body-limit') throw new HttpError(413, 'body-too-large');
    throw error;
  }
}

function safeRegistrationView(registration: TrackingRegistration): Record<string, unknown> {
  return {
    id: registration.id,
    installationId: registration.installationId,
    target: registration.target,
    baseBranch: registration.baseBranch,
    upstream: registration.upstream,
    policyHash: registration.policyHash,
    lastCheckedCommit: registration.lastCheckedCommit,
    lastSyncedCommit: registration.lastSyncedCommit,
    active: registration.active,
    revision: registration.revision,
  };
}

async function createRegistration(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<Response> {
  const parsed = parseRegistrationBody(await parseAdminJson(request));
  const github = dependencies.githubFor(env);
  const access = await github.verifyTrackingAccess({
    installationId: parsed.installationId,
    target: parsed.target,
    upstreamRepository: parsed.upstream.repository,
  });
  if (!access.targetAccessible || !access.targetWritable || !access.upstreamReadable) {
    throw new HttpError(403, 'installation-repository-access-denied');
  }
  await github.verifyRegistrationReferences({
    installationId: parsed.installationId,
    target: parsed.target,
    baseBranch: parsed.baseBranch,
    upstreamRepository: parsed.upstream.repository,
    upstreamRef: parsed.upstream.ref,
    baselineCommit: parsed.upstream.baselineCommit,
  });
  const digest = await policyHash(parsePolicy(parsed.policy));
  const registration = await dependencies.storeFor(env).createTrackingRegistration({
    ...parsed,
    id: `tracking_${crypto.randomUUID()}`,
    policyHash: digest,
    active: true,
  });
  return jsonResponse({ registration: safeRegistrationView(registration) }, 201);
}

async function setRegistrationActive(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
  trackingId: string,
): Promise<Response> {
  const body = await parseAdminJson(request);
  if (!isRecord(body)) throw new HttpError(400, 'invalid-registration-state');
  exactKeys(body, ['active', 'expectedRevision'], ['active', 'expectedRevision'], 'invalid-registration-state');
  if (typeof body.active !== 'boolean' || typeof body.expectedRevision !== 'number'
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new HttpError(400, 'invalid-registration-state');
  const store = dependencies.storeFor(env);
  const registration = await store.getTrackingRegistration(trackingId);
  if (!registration) throw new HttpError(404, 'registration-not-found');
  if (body.active) {
    const policy = parsePolicy(registration.policy);
    const github = dependencies.githubFor(env);
    const access = await github.verifyTrackingAccess({
      installationId: registration.installationId,
      target: registration.target,
      upstreamRepository: registration.upstream.repository,
    });
    if (!access.targetAccessible || !access.targetWritable || !access.upstreamReadable) {
      throw new HttpError(403, 'installation-repository-access-denied');
    }
    await github.verifyRegistrationReferences({
      installationId: registration.installationId,
      target: registration.target,
      baseBranch: registration.baseBranch,
      upstreamRepository: policy.upstream.repository,
      upstreamRef: policy.upstream.ref,
      baselineCommit: registration.upstream.baselineCommit,
    });
  }
  const updated = await store.setTrackingRegistrationActive({
    trackingId,
    expectedRevision: body.expectedRevision,
    active: body.active,
  });
  if (!updated) throw new HttpError(409, 'registration-revision-or-access-conflict');
  const current = await store.getTrackingRegistration(trackingId);
  if (!current) throw new HttpError(404, 'registration-not-found');
  return jsonResponse({ registration: safeRegistrationView(current) });
}

async function manualRun(
  env: Env,
  dependencies: WorkerDependencies,
  trackingId: string,
): Promise<Response> {
  const store = dependencies.storeFor(env);
  const registration = await store.getTrackingRegistration(trackingId);
  if (!registration || !registration.active || !await store.isTrackingEligible(trackingId)) {
    throw new HttpError(409, 'registration-inactive');
  }
  const now = dependencies.now ?? Date.now;
  const workId = `manual:${crypto.randomUUID()}`;
  const enqueued = await store.enqueueWork({ workId, kind: 'poll', trackingId, createdAt: new Date(now()).toISOString() });
  if (!enqueued) throw new HttpError(409, 'registration-no-longer-active');
  await flushQueueOutbox({ store, queue: dependencies.queueFor(env), now, limit: OUTBOX_FLUSH_SIZE });
  return jsonResponse({ accepted: true }, 202);
}

async function listRegistrations(env: Env, dependencies: WorkerDependencies): Promise<Response> {
  const store = dependencies.storeFor(env);
  const registrations: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listActiveTrackingRegistrations({ limit: 100, ...(cursor ? { cursor } : {}) });
    registrations.push(...page.registrations.map(safeRegistrationView));
    cursor = page.nextCursor;
  } while (cursor && registrations.length < 1_000);
  return jsonResponse({ registrations, truncated: cursor !== undefined });
}

async function routeAdmin(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
  pathname: string,
): Promise<Response> {
  if (!await isAdmin(request, env.ADMIN_TOKEN)) throw new HttpError(401, 'unauthorized');
  if (request.method === 'POST' && pathname === '/admin/registrations') return createRegistration(request, env, dependencies);
  if (request.method === 'GET' && pathname === '/admin/registrations') return listRegistrations(env, dependencies);
  const match = pathname.match(/^\/admin\/registrations\/([^/]+)(?:\/(active|run))?$/);
  if (!match) throw new HttpError(404, 'not-found');
  let trackingId: string;
  try {
    trackingId = decodeURIComponent(match[1]!);
  } catch {
    throw new HttpError(404, 'not-found');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(trackingId)) throw new HttpError(404, 'not-found');
  if (match[2] === 'active' && request.method === 'POST') return setRegistrationActive(request, env, dependencies, trackingId);
  if (match[2] === 'run' && request.method === 'POST') return manualRun(env, dependencies, trackingId);
  throw new HttpError(404, 'not-found');
}

async function routeFetch(request: Request, env: Env, dependencies: WorkerDependencies): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return jsonResponse({ status: 'ok' });
  if (url.pathname === '/webhooks/github' && request.method === 'POST') return handleVerifiedWebhook(request, env, dependencies);
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return routeAdmin(request, env, dependencies, url.pathname);
  return jsonResponse({ error: 'not-found' }, 404);
}

function isQueueMessage(value: unknown): value is QueueWorkMessage {
  if (!isRecord(value) || Object.keys(value).some(key => !['version', 'workId', 'kind', 'trackingId'].includes(key))) return false;
  return value.version === 1 && typeof value.workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value.workId)
    && (value.kind === 'poll' || value.kind === 'reconcile')
    && typeof value.trackingId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.trackingId);
}

async function targetJobName(registration: TrackingRegistration): Promise<string> {
  const key = [
    String(registration.installationId),
    registration.target.fullName.toLowerCase(),
    registration.baseBranch,
  ].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `target-${hex}`;
}

export async function consumeQueueBatch(
  batch: QueueBatchBinding,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<void> {
  const store = dependencies.storeFor(env);
  for (const message of batch.messages) {
    if (!isQueueMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const registration = await store.getTrackingRegistration(message.body.trackingId);
      if (!registration || !registration.active || !await store.isTrackingEligible(registration.id)) {
        message.ack();
        continue;
      }
      const object = dependencies.targetJobsFor(env).getByName(await targetJobName(registration));
      if (message.body.kind === 'reconcile') await object.reconcileTracking(registration.id);
      else await object.runTracking(registration.id);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function runScheduler(env: Env, dependencies: WorkerDependencies): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const store = dependencies.storeFor(env);
  const current = now();
  const timestamp = new Date(current).toISOString();
  await store.pruneExpiredRecords({ now: timestamp, limit: 500 });
  await store.enqueueDuePolls({
    now: timestamp,
    nextDueAt: new Date(current + FALLBACK_POLL_INTERVAL_MS).toISOString(),
    limit: SCHEDULER_BATCH_SIZE,
  });
  await flushQueueOutbox({ store, queue: dependencies.queueFor(env), now, limit: OUTBOX_FLUSH_SIZE });
}

async function secureFetch(request: Request, env: Env, dependencies: WorkerDependencies): Promise<Response> {
  try {
    return await routeFetch(request, env, dependencies);
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse({ error: error.code }, error.status);
    if (error instanceof GitHubClientError) {
      const status = error.code === 'webhook-body-limit' ? 413 : error.retryable ? 503 : 400;
      const response = jsonResponse({ error: error.code }, status);
      if (error.retryable && error.retryAfterSeconds !== undefined) {
        response.headers.set('retry-after', String(error.retryAfterSeconds));
      }
      return response;
    }
    if (error instanceof StoreError) {
      const status = error.code.includes('conflict') ? 409 : 400;
      return jsonResponse({ error: error.code }, status);
    }
    return jsonResponse({ error: 'internal-error' }, 500);
  }
}

export function createWorker(dependencies: WorkerDependencies) {
  return {
    fetch(request: Request, env: Env, _context: ExecutionContextBinding): Promise<Response> {
      return secureFetch(request, env, dependencies);
    },
    scheduled(_event: ScheduledEventBinding, env: Env, context: ExecutionContextBinding): void {
      context.waitUntil(runScheduler(env, dependencies));
    },
    queue(batch: QueueBatchBinding, env: Env, _context: ExecutionContextBinding): Promise<void> {
      return consumeQueueBatch(batch, env, dependencies);
    },
  };
}

const defaultWorker = createWorker({
  storeFor: env => new D1RegistryStore(env.DB),
  githubFor: env => new GitHubAppClient({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }),
  queueFor: env => env.JOB_QUEUE,
  targetJobsFor: env => env.TARGET_JOBS,
});

export default defaultWorker;
