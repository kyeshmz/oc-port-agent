import type {
  CheckpointCandidate,
  DiscoveredPlan,
  DraftPublication,
  DraftPublicationRequest,
  GitHubPort,
  PinnedPlan,
  PullRequestLifecycle,
  RepositoryIdentity,
  SnapshotFile,
  SourceSnapshot,
  StorePort,
  TargetSnapshot,
  TrackingRegistration,
  UpstreamChangedFile,
  VerifiedMergeObservation,
  VerifiedJobProposal,
  VerificationWorkspaceLimits,
  VerificationWorkspaceSnapshot,
} from './contracts.js';
import {
  DEFAULT_PROTECTED_PATHS,
  INTERNAL_PATHS,
  SENSITIVE_PATHS,
  MAX_GLOB_MATCH_WORK,
  createGlobWorkBudget,
  isProtectedOrSensitive,
  matchesAny,
  parsePolicy,
  policyHash,
  safePath,
  type GlobWorkBudget,
} from './policy.js';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const USER_AGENT = 'oc-port-agent-cloudflare/0.1';
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const MAX_REST_RESPONSE_BYTES = 16_000_000;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_RESPONSE_BYTES = 12_000_000;
const MAX_COMPARE_FILE_RESULTS = 300;
const MAX_REQUESTS_PER_OPERATION = 2_000;
const MAX_API_REQUEST_MS = 15_000;
const DEFAULT_CONTROL_OPERATION_SECONDS = 30;
const MAX_INSTALLATION_REPOSITORY_PAGES = 50;
// Reserve bounded token-inventory, installation-scope, commit and tree requests
// in addition to one request per pinned source file version.
const SOURCE_REQUEST_OVERHEAD = MAX_INSTALLATION_REPOSITORY_PAGES + 20;
const MAX_INSTALLATION_REPOSITORIES = MAX_INSTALLATION_REPOSITORY_PAGES * 100;
const MAX_OPEN_PR_LIST_PAGES = 10;

interface GitHubOperationContext {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly globBudget: GlobWorkBudget;
  requests: number;
  responseBytes: number;
}

type JsonRecord = Record<string, unknown>;
type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

export interface GitHubClientOptions {
  fetch?: HttpFetch;
  now?: () => number;
  /** Durable target-DO lookup required to validate merged PR contents against the verified proposal. */
  loadCheckpointEvidence?: (candidate: CheckpointCandidate) => Promise<CheckpointPublicationEvidence | undefined>;
}

export interface CheckpointPublicationEvidence {
  plan: PinnedPlan;
  proposal: VerifiedJobProposal;
}

export interface RegistrationReferenceInput {
  installationId: number;
  target: RepositoryIdentity;
  baseBranch: string;
  upstreamRepository: string;
  upstreamRef: string;
  baselineCommit: string;
}

/** Additional registration checks used by the authenticated control plane. */
export interface RegistrationGitHubPort extends GitHubPort {
  verifyRegistrationReferences(input: RegistrationReferenceInput): Promise<void>;
}

export interface TargetWorkspaceSnapshot {
  repository: RepositoryIdentity;
  commit: string;
  files: readonly SnapshotFile[];
}

export interface TargetWorkspaceReadInput {
  installationId: number;
  target: RepositoryIdentity;
  commit: string;
  excludedPathPatterns: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxBytes: number;
  maxDirectories: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxJobSeconds: number;
}

/** Host-only extension for test workspaces; never pass its access token to a runner. */
export interface TargetWorkspaceGitHubPort extends RegistrationGitHubPort {
  readTargetWorkspace(input: TargetWorkspaceReadInput): Promise<TargetWorkspaceSnapshot>;
}

export class GitHubClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: string, status?: number, retryable = false, retryAfterSeconds?: number) {
    super(code);
    this.name = 'GitHubClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Connects merge confirmation to the durable target-DO job record; missing or stale evidence fails closed. */
export function checkpointEvidenceLoader(
  store: Pick<StorePort, 'getJob'>,
): (candidate: CheckpointCandidate) => Promise<CheckpointPublicationEvidence | undefined> {
  return async candidate => {
    const job = await store.getJob(candidate.jobId);
    if (!job || !['ready-to-publish', 'published'].includes(job.status) || job.id !== candidate.jobId
      || job.trackingId !== candidate.trackingId || job.key !== candidate.jobKey
      || job.plan.jobId !== candidate.jobId || job.plan.jobKey !== candidate.jobKey
      || job.plan.policyHash !== candidate.policyHash || job.plan.toCommit !== candidate.upstreamCommit
      || job.plan.targetBaseCommit !== candidate.targetBaseCommit
      || job.plan.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit) return undefined;
    const proposal = job.proposal;
    if (!proposal?.verification || proposal.verification.status !== 'passed'
      || proposal.checkpointCandidate.jobId !== candidate.jobId
      || proposal.checkpointCandidate.jobKey !== candidate.jobKey
      || proposal.checkpointCandidate.trackingId !== candidate.trackingId
      || proposal.checkpointCandidate.upstreamCommit !== candidate.upstreamCommit
      || proposal.checkpointCandidate.targetBaseCommit !== candidate.targetBaseCommit
      || proposal.checkpointCandidate.policyHash !== candidate.policyHash
      || proposal.checkpointCandidate.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit
      || proposal.checkpointCandidate.expectedLastSyncedCommit !== candidate.expectedLastSyncedCommit) return undefined;
    const verifiedProposal: VerifiedJobProposal = { ...proposal, verification: proposal.verification };
    return { plan: job.plan, proposal: verifiedProposal };
  };
}

interface InstallationToken {
  value: string;
  expiresAt: number;
  repositories?: readonly string[];
}

type TokenPermissionProfile = 'read' | 'publish';

interface RepositoryLocation {
  owner: string;
  name: string;
  fullName: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface CommitMetadata {
  sha: string;
  treeSha: string;
  message: string;
  parents: string[];
}

interface PullRequestRecord {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeCommitSha?: string;
  baseRef: string;
  baseRepository: string;
  baseSha: string;
  headRef: string;
  headRepository: string;
  headSha: string;
  url: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) throw new GitHubClientError(code);
  return value;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new GitHubClientError(code);
  return value;
}

function validCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64(value: string, allowEmpty = false): Uint8Array {
  const normalized = value.replace(/[\r\n\t ]/g, '');
  if ((!normalized && !allowEmpty) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new GitHubClientError('invalid-github-base64');
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new GitHubClientError('invalid-github-base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derElement(tag: number, content: Uint8Array): Uint8Array {
  return concatenate([new Uint8Array([tag]), derLength(content.length), content]);
}

function privateKeyDer(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const pkcs8Match = trimmed.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----$/);
  const pkcs1Match = trimmed.match(/^-----BEGIN RSA PRIVATE KEY-----([\s\S]+)-----END RSA PRIVATE KEY-----$/);
  const match = pkcs8Match ?? pkcs1Match;
  if (!match) throw new GitHubClientError('invalid-app-private-key');
  const keyBytes = decodeBase64(match[1]!);
  if (pkcs8Match) return keyBytes;

  // WebCrypto imports PKCS#8, while GitHub downloads RSA keys in PKCS#1 PEM.
  const algorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const wrappedKey = derElement(0x04, keyBytes);
  return derElement(0x30, concatenate([version, algorithmIdentifier, wrappedKey]));
}

function parseRepositoryUrl(value: string): RepositoryLocation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubClientError('invalid-upstream-repository');
  }
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port
    || url.username || url.password || url.search || url.hash || segments.length !== 2
    || !REPOSITORY_PART.test(segments[0]!) || !REPOSITORY_PART.test(segments[1]!)) {
    throw new GitHubClientError('invalid-upstream-repository');
  }
  return { owner: segments[0]!, name: segments[1]!, fullName: `${segments[0]}/${segments[1]}` };
}

function validRepository(identity: RepositoryIdentity): boolean {
  return REPOSITORY_PART.test(identity.owner) && REPOSITORY_PART.test(identity.name)
    && identity.fullName.toLowerCase() === `${identity.owner}/${identity.name}`.toLowerCase();
}

function repoPath(repository: RepositoryLocation, suffix: string): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function objectSha(value: unknown, field: string): string {
  const record = requiredRecord(value, `invalid-${field}`);
  const sha = record.sha;
  if (!validCommit(sha)) throw new GitHubClientError(`invalid-${field}`);
  return sha;
}

function isoNow(now: () => number): string {
  const value = new Date(now()).toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new GitHubClientError('invalid-clock');
  return value;
}

function createOperationContext(
  maxJobSeconds: number,
  maxResponseBytes: number,
  maxRequests = MAX_REQUESTS_PER_OPERATION,
): GitHubOperationContext {
  if (!Number.isFinite(maxJobSeconds) || maxJobSeconds <= 0
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS_PER_OPERATION) {
    throw new GitHubClientError('invalid-github-operation-budget');
  }
  const startedAt = performance.now();
  return {
    startedAt,
    deadlineAt: startedAt + maxJobSeconds * 1_000,
    maxRequests,
    maxResponseBytes,
    globBudget: createGlobWorkBudget(MAX_GLOB_MATCH_WORK),
    requests: 0,
    responseBytes: 0,
  };
}

function remainingOperationMs(context: GitHubOperationContext): number {
  const remaining = context.deadlineAt - performance.now();
  if (remaining <= 0) throw new GitHubClientError('github-operation-time-limit');
  return remaining;
}

function checkOperation(context: GitHubOperationContext): void {
  remainingOperationMs(context);
}

function retryDelaySeconds(response: Response, now: () => number): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.min(3_600, Math.ceil(seconds)));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1, Math.min(3_600, Math.ceil((date - now()) / 1_000)));
  }
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset && /^\d+$/.test(reset)) {
    return Math.max(1, Math.min(3_600, Math.ceil(Number(reset) - now() / 1_000)));
  }
  return undefined;
}

async function readResponseBytes(response: Response, maximum: number, context?: GitHubOperationContext): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (context) checkOperation(context);
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (context) context.responseBytes += result.value.byteLength;
      if (total > maximum || (context && context.responseBytes > context.maxResponseBytes)) {
        await reader.cancel();
        throw new GitHubClientError(context && context.responseBytes > context.maxResponseBytes
          ? 'github-operation-response-limit'
          : 'github-response-limit');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks);
}

async function readJson(response: Response, maximum: number, context?: GitHubOperationContext): Promise<unknown> {
  const bytes = await readResponseBytes(response, maximum, context);
  if (bytes.length === 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubClientError('invalid-github-response-utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubClientError('invalid-github-json');
  }
}

function cleanText(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  const output = normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
  if (new TextEncoder().encode(output).length > maxBytes) throw new GitHubClientError('publication-text-limit');
  return output;
}

function expectedJobBranch(key: string): string {
  if (!/^job_[a-f0-9]{64}$/i.test(key)) throw new GitHubClientError('invalid-publication-key');
  return `oc-port-agent-${key.slice(4).toLowerCase()}`;
}

function branchMarker(jobKey: string): string {
  return `oc-port-agent-job: ${jobKey}`;
}

function targetBranchName(branch: string): string {
  if (!branch || branch.length > 255 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')
    || branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || branch.includes('//')
    || /[ ~^:?*\[\\\x00-\x20\x7f]/.test(branch)) throw new GitHubClientError('invalid-target-branch');
  return branch;
}

function sameRepositoryName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parsePullRequest(value: unknown): PullRequestRecord {
  const raw = requiredRecord(value, 'invalid-pull-request');
  const base = requiredRecord(raw.base, 'invalid-pull-request');
  const head = requiredRecord(raw.head, 'invalid-pull-request');
  const baseRepo = requiredRecord(base.repo, 'invalid-pull-request');
  const headRepo = requiredRecord(head.repo, 'invalid-pull-request');
  const merged = raw.merged === true || typeof raw.merged_at === 'string';
  if (!Number.isSafeInteger(raw.number) || Number(raw.number) < 1
    || typeof raw.state !== 'string' || typeof raw.draft !== 'boolean'
    || typeof base.ref !== 'string' || typeof base.sha !== 'string'
    || typeof baseRepo.full_name !== 'string' || typeof head.ref !== 'string' || typeof head.sha !== 'string'
    || typeof headRepo.full_name !== 'string' || typeof raw.html_url !== 'string') {
    throw new GitHubClientError('invalid-pull-request');
  }
  if (!validCommit(base.sha) || !validCommit(head.sha)) throw new GitHubClientError('invalid-pull-request');
  const mergeCommitSha = raw.merge_commit_sha === null || raw.merge_commit_sha === undefined
    ? undefined
    : validCommit(raw.merge_commit_sha) ? raw.merge_commit_sha : undefined;
  if (raw.merge_commit_sha !== null && raw.merge_commit_sha !== undefined && !mergeCommitSha) {
    throw new GitHubClientError('invalid-pull-request');
  }
  return {
    number: Number(raw.number),
    state: raw.state,
    draft: raw.draft,
    merged,
    ...(mergeCommitSha ? { mergeCommitSha } : {}),
    baseRef: base.ref,
    baseRepository: baseRepo.full_name,
    baseSha: base.sha,
    headRef: head.ref,
    headRepository: headRepo.full_name,
    headSha: head.sha,
    url: raw.html_url,
  };
}

function utf8Bytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== value || value.includes('\0')) {
    throw new GitHubClientError('invalid-file-utf8');
  }
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class GitHubAppClient implements TargetWorkspaceGitHubPort {
  private readonly fetcher: HttpFetch;
  private readonly now: () => number;
  private readonly loadCheckpointEvidence: GitHubClientOptions['loadCheckpointEvidence'];
  private readonly tokenCache = new Map<string, InstallationToken>();
  private readonly inventoryTokenCache = new Map<number, InstallationToken>();
  private readonly repositoryIdCache = new Map<number, Map<string, number>>();
  private signingKey?: Promise<CryptoKey>;

  constructor(private readonly credentials: GitHubAppCredentials, options: GitHubClientOptions = {}) {
    if (!/^\d{1,20}$/.test(credentials.appId) || credentials.privateKey.length > 100_000) {
      throw new GitHubClientError('invalid-app-credentials');
    }
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.loadCheckpointEvidence = options.loadCheckpointEvidence;
  }

  private getSigningKey(): Promise<CryptoKey> {
    this.signingKey ??= crypto.subtle.importKey(
      'pkcs8',
      cryptoBuffer(privateKeyDer(this.credentials.privateKey)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.signingKey;
  }

  private async appJwt(): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1_000) - 60;
    const expiresAt = issuedAt + 600;
    const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: this.credentials.appId })));
    const unsigned = `${header}.${payload}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.getSigningKey(), cryptoBuffer(new TextEncoder().encode(unsigned)));
    return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  private async request(path: string, options: {
    method?: string;
    token?: string;
    body?: unknown;
    maxResponseBytes?: number;
    context?: GitHubOperationContext;
  } = {}): Promise<unknown> {
    const context = options.context;
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/')) throw new GitHubClientError('github-url-rejected');
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (new TextEncoder().encode(body).length > 12_000_000) throw new GitHubClientError('github-request-limit');
      headers.set('Content-Type', 'application/json');
    }
    let requestTimeoutMs = MAX_API_REQUEST_MS;
    if (context) {
      const remaining = remainingOperationMs(context);
      if (context.requests >= context.maxRequests) throw new GitHubClientError('github-operation-request-limit');
      context.requests++;
      requestTimeoutMs = Math.max(1, Math.floor(Math.min(MAX_API_REQUEST_MS, remaining)));
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new GitHubClientError('github-transport-failure', undefined, true);
    }
    if (context) checkOperation(context);
    if (!response.ok) {
      const retryAfterSeconds = retryDelaySeconds(response, this.now);
      const rateLimited = response.status === 403
        && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500 || rateLimited;
      if (response.body) await response.body.cancel().catch(() => undefined);
      if (context) checkOperation(context);
      throw new GitHubClientError(
        retryable ? 'github-transient-api-failure' : 'github-api-failure',
        response.status,
        retryable,
        retryAfterSeconds,
      );
    }
    const payload = await readJson(response, options.maxResponseBytes ?? MAX_REST_RESPONSE_BYTES, context);
    if (context) checkOperation(context);
    return payload;
  }

  private async mintInstallationToken(
    installationId: number,
    body: unknown,
    context: GitHubOperationContext,
  ): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw new GitHubClientError('invalid-installation-id');
    const jwt = await this.appJwt();
    const result = requiredRecord(await this.request(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: jwt,
      body,
      maxResponseBytes: 256_000,
      context,
    }), 'invalid-installation-token-response');
    const value = requiredString(result.token, 'invalid-installation-token-response');
    const expiresAt = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() + 60_000) throw new GitHubClientError('invalid-installation-token-expiry');
    let repositories: string[] | undefined;
    if (result.repositories !== undefined) {
      if (!Array.isArray(result.repositories)) throw new GitHubClientError('invalid-installation-token-scope');
      repositories = result.repositories.map(item => requiredString(requiredRecord(item, 'invalid-installation-token-scope').full_name, 'invalid-installation-token-scope'));
    }
    return { value, expiresAt, ...(repositories ? { repositories } : {}) };
  }

  private async inventoryToken(installationId: number, context: GitHubOperationContext): Promise<string> {
    const cached = this.inventoryTokenCache.get(installationId);
    if (cached && cached.expiresAt - this.now() > 60_000) return cached.value;
    const token = await this.mintInstallationToken(installationId, { permissions: { metadata: 'read' } }, context);
    this.inventoryTokenCache.set(installationId, token);
    return token.value;
  }

  private async repositoryIds(installationId: number, context: GitHubOperationContext): Promise<ReadonlyMap<string, number>> {
    const cached = this.repositoryIdCache.get(installationId);
    if (cached) return cached;
    const token = await this.inventoryToken(installationId, context);
    const repositories = new Map<string, number>();
    let totalCount: number | undefined;
    let seen = 0;
    for (let page = 1; page <= MAX_INSTALLATION_REPOSITORY_PAGES; page++) {
      const query = new URLSearchParams({ per_page: '100', page: String(page) });
      const raw = requiredRecord(await this.request(`/installation/repositories?${query.toString()}`, {
        token,
        maxResponseBytes: 2_000_000,
        context,
      }), 'invalid-installation-repository-list');
      if (!Array.isArray(raw.repositories)) throw new GitHubClientError('invalid-installation-repository-list');
      if (raw.total_count !== undefined) {
        if (!Number.isSafeInteger(raw.total_count) || Number(raw.total_count) < 0 || Number(raw.total_count) > MAX_INSTALLATION_REPOSITORIES) {
          throw new GitHubClientError('installation-repository-limit');
        }
        if (totalCount !== undefined && totalCount !== raw.total_count) throw new GitHubClientError('installation-repository-list-changed');
        totalCount = Number(raw.total_count);
      }
      for (const value of raw.repositories) {
        checkOperation(context);
        const item = requiredRecord(value, 'invalid-installation-repository');
        const fullName = requiredString(item.full_name, 'invalid-installation-repository');
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)
          || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 1) {
          throw new GitHubClientError('invalid-installation-repository');
        }
        const key = fullName.toLowerCase();
        const prior = repositories.get(key);
        if (prior !== undefined) throw new GitHubClientError('duplicate-installation-repository');
        repositories.set(key, item.id);
        seen++;
        if (seen > MAX_INSTALLATION_REPOSITORIES) throw new GitHubClientError('installation-repository-limit');
      }
      if (totalCount !== undefined && seen >= totalCount) break;
      if (raw.repositories.length < 100) break;
      if (page === MAX_INSTALLATION_REPOSITORY_PAGES) throw new GitHubClientError('installation-repository-list-truncated');
    }
    if (totalCount !== undefined && seen !== totalCount) throw new GitHubClientError('installation-repository-list-truncated');
    this.repositoryIdCache.set(installationId, repositories);
    return repositories;
  }

  private async installationToken(
    installationId: number,
    repository: RepositoryLocation,
    context: GitHubOperationContext,
    profile: TokenPermissionProfile = 'read',
  ): Promise<string> {
    const repositoryId = (await this.repositoryIds(installationId, context)).get(repository.fullName.toLowerCase());
    if (repositoryId === undefined) throw new GitHubClientError('repository-not-in-installation');
    const cacheKey = `${installationId}:${profile}:${repositoryId}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - this.now() > 60_000) return cached.value;
    const token = await this.mintInstallationToken(installationId, {
      repository_ids: [repositoryId],
      permissions: profile === 'publish'
        ? { contents: 'write', metadata: 'read', pull_requests: 'write' }
        : { contents: 'read', metadata: 'read' },
    }, context);
    if (!token.repositories || token.repositories.length !== 1
      || !sameRepositoryName(token.repositories[0]!, repository.fullName)) {
      throw new GitHubClientError('installation-token-scope-mismatch');
    }
    this.tokenCache.set(cacheKey, token);
    return token.value;
  }

  private async tokenForRepository(
    installationId: number,
    repository: RepositoryLocation,
    context: GitHubOperationContext,
    profile: TokenPermissionProfile = 'read',
  ): Promise<string> {
    return this.installationToken(installationId, repository, context, profile);
  }

  private async resolveUpstreamReadToken(
    installationId: number,
    repository: RepositoryLocation,
    context: GitHubOperationContext,
  ): Promise<string | undefined> {
    let token: string | undefined;
    try {
      token = await this.tokenForRepository(installationId, repository, context);
    } catch (error) {
      if (error instanceof GitHubClientError && error.retryable) throw error;
      if (!(error instanceof GitHubClientError)
        || (error.code !== 'repository-not-in-installation' && error.code !== 'installation-token-scope-mismatch'
          && error.code !== 'installation-repository-limit' && error.code !== 'installation-repository-list-truncated'
          && !(error.status && [403, 404, 422].includes(error.status)))) throw error;
    }
    if (token) {
      try {
        const authenticated = await this.getRepository(repository, token, context);
        if (!sameRepositoryName(authenticated.fullName, repository.fullName)) throw new GitHubClientError('upstream-repository-mismatch');
        return token;
      } catch (error) {
        if (!(error instanceof GitHubClientError) || (error.status !== 403 && error.status !== 404)) throw error;
      }
    }
    let anonymous: { fullName: string; writable: boolean; isPrivate: boolean };
    try {
      anonymous = await this.getRepository(repository, undefined, context);
    } catch (error) {
      if (error instanceof GitHubClientError && (error.status === 403 || error.status === 404)) {
        if (error.retryable) throw error;
        throw new GitHubClientError('upstream-read-access-denied', error.status);
      }
      throw error;
    }
    if (!sameRepositoryName(anonymous.fullName, repository.fullName)) throw new GitHubClientError('upstream-repository-mismatch');
    if (anonymous.isPrivate) throw new GitHubClientError('upstream-read-access-denied');
    return undefined;
  }

  private async getRepository(
    repository: RepositoryLocation,
    token: string | undefined,
    context: GitHubOperationContext,
  ): Promise<{ fullName: string; writable: boolean; isPrivate: boolean }> {
    const raw = requiredRecord(await this.request(repoPath(repository, ''), {
      ...(token ? { token } : {}),
      maxResponseBytes: 256_000,
      context,
    }), 'invalid-repository-response');
    const fullName = requiredString(raw.full_name, 'invalid-repository-response');
    const permissions = isRecord(raw.permissions) ? raw.permissions : {};
    if (typeof raw.private !== 'boolean') throw new GitHubClientError('invalid-repository-response');
    return {
      fullName,
      writable: permissions.push === true || permissions.maintain === true || permissions.admin === true,
      isPrivate: raw.private,
    };
  }

  async verifyTrackingAccess(input: {
    installationId: number;
    target: RepositoryIdentity;
    upstreamRepository: string;
  }): Promise<{ targetAccessible: boolean; targetWritable: boolean; upstreamReadable: boolean }> {
    const context = createOperationContext(DEFAULT_CONTROL_OPERATION_SECONDS, 4_000_000, MAX_INSTALLATION_REPOSITORY_PAGES + 24);
    return this.verifyTrackingAccessWithContext(input, context);
  }

  private async verifyTrackingAccessWithContext(input: {
    installationId: number;
    target: RepositoryIdentity;
    upstreamRepository: string;
  }, context: GitHubOperationContext): Promise<{ targetAccessible: boolean; targetWritable: boolean; upstreamReadable: boolean }> {
    if (!validRepository(input.target)) throw new GitHubClientError('invalid-target-repository');
    const target: RepositoryLocation = { ...input.target };
    const upstream = parseRepositoryUrl(input.upstreamRepository);
    let targetToken: string;
    try {
      targetToken = await this.tokenForRepository(input.installationId, target, context, 'publish');
    } catch (error) {
      if (error instanceof GitHubClientError && error.retryable) throw error;
      if (error instanceof GitHubClientError && error.status === 422) {
        throw new GitHubClientError('github-access-indeterminate', error.status, true, error.retryAfterSeconds);
      }
      if (error instanceof GitHubClientError
        && (error.code === 'repository-not-in-installation' || (error.status !== undefined && [403, 404].includes(error.status)))) {
        return { targetAccessible: false, targetWritable: false, upstreamReadable: false };
      }
      throw error;
    }
    let targetRepo: { fullName: string; writable: boolean; isPrivate: boolean };
    try {
      targetRepo = await this.getRepository(target, targetToken, context);
    } catch (error) {
      if (error instanceof GitHubClientError && error.retryable) throw error;
      if (error instanceof GitHubClientError && (error.status === 403 || error.status === 404)) {
        return { targetAccessible: false, targetWritable: false, upstreamReadable: false };
      }
      if (error instanceof GitHubClientError && error.status === 422) {
        throw new GitHubClientError('github-access-indeterminate', error.status, true, error.retryAfterSeconds);
      }
      throw error;
    }
    if (!sameRepositoryName(targetRepo.fullName, target.fullName)) throw new GitHubClientError('target-repository-mismatch');

    let upstreamReadable = false;
    try {
      await this.resolveUpstreamReadToken(input.installationId, upstream, context);
      upstreamReadable = true;
    } catch (error) {
      if (!(error instanceof GitHubClientError) || error.code !== 'upstream-read-access-denied') throw error;
    }
    return { targetAccessible: true, targetWritable: targetRepo.writable, upstreamReadable };
  }

  async verifyRegistrationReferences(input: RegistrationReferenceInput): Promise<void> {
    const context = createOperationContext(DEFAULT_CONTROL_OPERATION_SECONDS, 8_000_000, MAX_INSTALLATION_REPOSITORY_PAGES + 32);
    if (!validRepository(input.target) || !validCommit(input.baselineCommit)) throw new GitHubClientError('invalid-registration-reference');
    targetBranchName(input.baseBranch);
    const upstream = parseRepositoryUrl(input.upstreamRepository);
    const access = await this.verifyTrackingAccessWithContext({
      installationId: input.installationId,
      target: input.target,
      upstreamRepository: input.upstreamRepository,
    }, context);
    if (!access.targetAccessible || !access.targetWritable || !access.upstreamReadable) {
      throw new GitHubClientError('registration-repository-access-denied');
    }
    const target: RepositoryLocation = { ...input.target };
    const targetToken = await this.tokenForRepository(input.installationId, target, context);
    const baseBranch = await this.getBranch(target, input.baseBranch, targetToken, context);
    if (!validCommit(baseBranch)) throw new GitHubClientError('invalid-target-base');
    const upstreamToken = await this.resolveUpstreamReadToken(input.installationId, upstream, context);
    const ref = await this.getCommit(upstream, input.upstreamRef, upstreamToken, context);
    const relation = await this.compareRelationship(upstream, input.baselineCommit, ref.sha, upstreamToken, context);
    if ((relation.status !== 'ahead' && relation.status !== 'identical')
      || relation.mergeBase.toLowerCase() !== input.baselineCommit.toLowerCase()) {
      throw new GitHubClientError('baseline-not-on-configured-upstream');
    }
  }

  async discoverPlan(registration: TrackingRegistration, policy: ReturnType<typeof parsePolicy>): Promise<DiscoveredPlan | undefined> {
    const context = createOperationContext(
      policy.limits.maxJobSeconds,
      Math.min(64_000_000, MAX_REST_RESPONSE_BYTES * (Math.ceil(policy.limits.maxCommits / 100) + 2)),
      Math.min(MAX_REQUESTS_PER_OPERATION, 2 * Math.ceil(policy.limits.maxCommits / 100) + MAX_INSTALLATION_REPOSITORY_PAGES + 40),
    );
    const upstream = parseRepositoryUrl(policy.upstream.repository);
    const target: RepositoryLocation = { ...registration.target };
    const upstreamToken = await this.resolveUpstreamReadToken(registration.installationId, upstream, context);
    const current = await this.getCommit(upstream, policy.upstream.ref, upstreamToken, context);
    if (current.sha.toLowerCase() === registration.lastCheckedCommit.toLowerCase()
      && current.sha.toLowerCase() === registration.lastSyncedCommit.toLowerCase()) return undefined;
    const compare = await this.compare(
      upstream,
      registration.lastSyncedCommit,
      current.sha,
      upstreamToken,
      policy.limits.maxCommits,
      policy.limits.maxChangedPaths,
      context,
    );
    if ((compare.status !== 'ahead' && compare.status !== 'identical')
      || compare.mergeBase.toLowerCase() !== registration.lastSyncedCommit.toLowerCase()
      || compare.totalCommits > policy.limits.maxCommits) {
      throw new GitHubClientError('upstream-history-ambiguous');
    }
    let checkedChangedPaths: string[] = registration.lastCheckedCommit.toLowerCase() === registration.lastSyncedCommit.toLowerCase()
      ? [...compare.paths]
      : [];
    if (current.sha.toLowerCase() !== registration.lastCheckedCommit.toLowerCase()
      && registration.lastCheckedCommit.toLowerCase() !== registration.lastSyncedCommit.toLowerCase()) {
      const checkedCompare = await this.compare(
        upstream,
        registration.lastCheckedCommit,
        current.sha,
        upstreamToken,
        policy.limits.maxCommits,
        policy.limits.maxChangedPaths,
        context,
      );
      if (checkedCompare.status !== 'ahead' || checkedCompare.mergeBase.toLowerCase() !== registration.lastCheckedCommit.toLowerCase()
        || checkedCompare.totalCommits < 1 || checkedCompare.totalCommits > policy.limits.maxCommits) {
        throw new GitHubClientError('checked-upstream-history-ambiguous');
      }
      checkedChangedPaths = checkedCompare.paths;
    }
    // Resolve the configured target base after the upstream compare, then re-read the upstream ref.
    // If either ref moved during discovery, fail rather than pin a mixed view.
    const targetToken = await this.tokenForRepository(registration.installationId, target, context);
    const targetBaseCommit = await this.getBranch(target, registration.baseBranch, targetToken, context);
    const confirmed = await this.getCommit(upstream, policy.upstream.ref, upstreamToken, context);
    if (confirmed.sha.toLowerCase() !== current.sha.toLowerCase()) throw new GitHubClientError('upstream-ref-moved-during-discovery');
    return {
      trackingId: registration.id,
      installationId: registration.installationId,
      target: { ...registration.target },
      baseBranch: registration.baseBranch,
      targetBaseCommit,
      upstreamRepository: policy.upstream.repository,
      upstreamRef: policy.upstream.ref,
      fromCommit: registration.lastSyncedCommit,
      expectedLastCheckedCommit: registration.lastCheckedCommit,
      toCommit: current.sha,
      commitCount: compare.totalCommits,
      changedPaths: compare.paths,
      changedFiles: compare.changedFiles,
      checkedChangedPaths,
      observedAt: isoNow(this.now),
    };
  }

  private async compare(
    repository: RepositoryLocation,
    from: string,
    to: string,
    token: string | undefined,
    maxCommits: number,
    maxChangedPaths: number,
    context: GitHubOperationContext,
  ): Promise<{ status: string; mergeBase: string; totalCommits: number; paths: string[]; changedFiles: UpstreamChangedFile[] }> {
    const url = new URL(repoPath(repository, `/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`), API_ORIGIN);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', '1');
    const first = requiredRecord(await this.request(url.pathname + url.search, {
      ...(token ? { token } : {}), maxResponseBytes: MAX_REST_RESPONSE_BYTES, context,
    }), 'invalid-compare-response');
    const total = first.total_commits;
    const status = first.status;
    const baseSha = objectSha(first.base_commit, 'compare-base');
    const mergeBase = objectSha(first.merge_base_commit, 'compare-merge-base');
    if (!Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > maxCommits
      || typeof status !== 'string' || !['ahead', 'behind', 'identical', 'diverged'].includes(status)) {
      throw new GitHubClientError('compare-limit-or-shape');
    }
    const pages = Math.max(1, Math.ceil(Number(total) / 100));
    if (pages > Math.ceil(maxCommits / 100) + 1 || pages > 101) throw new GitHubClientError('compare-page-limit');
    const commits: string[] = [];
    let files: unknown[] = [];
    for (let page = 1; page <= pages; page++) {
      const pageUrl = new URL(repoPath(repository, `/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`), API_ORIGIN);
      pageUrl.searchParams.set('per_page', '100');
      pageUrl.searchParams.set('page', String(page));
      const raw = page === 1
        ? first
        : requiredRecord(await this.request(pageUrl.pathname + pageUrl.search, {
          ...(token ? { token } : {}), maxResponseBytes: MAX_REST_RESPONSE_BYTES, context,
        }), 'invalid-compare-response');
      if (raw.total_commits !== total || raw.status !== status || objectSha(raw.base_commit, 'compare-base') !== baseSha
        || objectSha(raw.merge_base_commit, 'compare-merge-base') !== mergeBase) {
        throw new GitHubClientError('compare-changed-between-pages');
      }
      if (!Array.isArray(raw.commits) || (page === 1 && !Array.isArray(raw.files))) {
        throw new GitHubClientError('invalid-compare-response');
      }
      const pageFiles = page === 1 ? raw.files : raw.files ?? [];
      if (!Array.isArray(pageFiles)) throw new GitHubClientError('invalid-compare-response');
      for (const value of raw.commits) {
        checkOperation(context);
        const commit = requiredRecord(value, 'invalid-compare-commit');
        if (!validCommit(commit.sha)) throw new GitHubClientError('invalid-compare-commit');
        commits.push(commit.sha);
        if (commits.length > Number(total) || commits.length > maxCommits) throw new GitHubClientError('compare-commit-overflow');
      }
      if (page === 1) files = pageFiles;
      if (page < pages && raw.commits.length !== 100) throw new GitHubClientError('compare-truncated');
    }
    if (commits.length !== Number(total) || new Set(commits).size !== commits.length) throw new GitHubClientError('compare-truncated');

    if (files.length >= MAX_COMPARE_FILE_RESULTS) throw new GitHubClientError('compare-files-truncated');
    const changes = new Map<string, UpstreamChangedFile>();
    const addChange = (path: string, changeStatus: UpstreamChangedFile['status']): void => {
      if (changes.has(path)) throw new GitHubClientError('compare-duplicate-file-path');
      changes.set(path, { path, status: changeStatus });
      if (changes.size > maxChangedPaths) throw new GitHubClientError('compare-path-limit');
    };
    for (const value of files) {
      checkOperation(context);
      const file = requiredRecord(value, 'invalid-compare-file');
      if (typeof file.filename !== 'string' || typeof file.status !== 'string') throw new GitHubClientError('invalid-compare-file');
      if (!['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status)) {
        throw new GitHubClientError('invalid-compare-file-status');
      }
      if (!safePath(file.filename)) throw new GitHubClientError('unsafe-github-path');
      if (file.status === 'renamed') {
        if (typeof file.previous_filename !== 'string' || !safePath(file.previous_filename)) throw new GitHubClientError('invalid-rename-path');
        addChange(file.previous_filename, 'deleted');
        addChange(file.filename, 'added');
      } else if (file.status === 'added' || file.status === 'copied') addChange(file.filename, 'added');
      else if (file.status === 'removed') addChange(file.filename, 'deleted');
      else if (file.status === 'modified' || file.status === 'changed') addChange(file.filename, 'modified');
      else throw new GitHubClientError('invalid-compare-file-status');
    }
    if (baseSha.toLowerCase() !== from.toLowerCase()) throw new GitHubClientError('compare-base-mismatch');
    const changedFiles = [...changes.values()];
    return { status, mergeBase, totalCommits: Number(total), paths: changedFiles.map(file => file.path), changedFiles };
  }

  private async compareRelationship(
    repository: RepositoryLocation,
    from: string,
    to: string,
    token: string | undefined,
    context: GitHubOperationContext,
  ): Promise<{ status: string; mergeBase: string }> {
    const url = new URL(repoPath(repository, `/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`), API_ORIGIN);
    url.searchParams.set('per_page', '1');
    url.searchParams.set('page', '1');
    const raw = requiredRecord(await this.request(url.pathname + url.search, {
      ...(token ? { token } : {}),
      maxResponseBytes: MAX_REST_RESPONSE_BYTES,
      context,
    }), 'invalid-compare-response');
    const status = raw.status;
    const total = raw.total_commits;
    const baseSha = objectSha(raw.base_commit, 'compare-base');
    const mergeBase = objectSha(raw.merge_base_commit, 'compare-merge-base');
    if (typeof status !== 'string' || !['ahead', 'behind', 'identical', 'diverged'].includes(status)
      || !Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > 1_000_000
      || baseSha.toLowerCase() !== from.toLowerCase()) throw new GitHubClientError('invalid-compare-response');
    return { status, mergeBase };
  }

  private async getCommit(
    repository: RepositoryLocation,
    ref: string,
    token: string | undefined,
    context: GitHubOperationContext,
  ): Promise<{ sha: string; treeSha: string; message: string; parents: string[] }> {
    if (!ref || ref.length > 255 || /[\x00-\x20\x7f]/.test(ref)) throw new GitHubClientError('invalid-github-ref');
    const raw = requiredRecord(await this.request(repoPath(repository, `/commits/${encodeURIComponent(ref)}`), {
      ...(token ? { token } : {}), maxResponseBytes: 2_000_000, context,
    }), 'invalid-github-commit');
    const sha = requiredString(raw.sha, 'invalid-github-commit');
    if (!validCommit(sha)) throw new GitHubClientError('invalid-github-commit');
    const commit = requiredRecord(raw.commit, 'invalid-github-commit');
    const treeSha = objectSha(commit.tree, 'commit-tree');
    const message = requiredString(commit.message, 'invalid-github-commit');
    const parentsRaw = raw.parents;
    if (!Array.isArray(parentsRaw)) throw new GitHubClientError('invalid-github-commit');
    const parents = parentsRaw.map(value => objectSha(value, 'commit-parent'));
    return { sha, treeSha, message, parents };
  }

  private async getBranch(repository: RepositoryLocation, branch: string, token: string, context: GitHubOperationContext): Promise<string> {
    targetBranchName(branch);
    const raw = requiredRecord(await this.request(repoPath(repository, `/branches/${encodeURIComponent(branch)}`), {
      token,
      maxResponseBytes: 512_000,
      context,
    }), 'invalid-branch-response');
    if (raw.name !== branch) throw new GitHubClientError('branch-name-mismatch');
    const commit = requiredRecord(raw.commit, 'invalid-branch-response');
    return objectSha(commit, 'branch-commit');
  }

  private async getTree(
    repository: RepositoryLocation,
    treeSha: string,
    token: string | undefined,
    context: GitHubOperationContext,
    maximumBytes = MAX_TREE_RESPONSE_BYTES,
  ): Promise<TreeEntry[]> {
    if (!validCommit(treeSha)) throw new GitHubClientError('invalid-tree-sha');
    const raw = requiredRecord(await this.request(repoPath(repository, `/git/trees/${treeSha}?recursive=1`), {
      ...(token ? { token } : {}),
      maxResponseBytes: maximumBytes,
      context,
    }), 'invalid-tree-response');
    if (raw.sha !== treeSha) throw new GitHubClientError('tree-sha-mismatch');
    if (raw.truncated !== false || !Array.isArray(raw.tree) || raw.tree.length > MAX_TREE_ENTRIES) {
      throw new GitHubClientError('github-tree-truncated');
    }
    const seen = new Set<string>();
    const entries: TreeEntry[] = [];
    for (let index = 0; index < raw.tree.length; index++) {
      if ((index & 255) === 0) checkOperation(context);
      const value = raw.tree[index];
      const entry = requiredRecord(value, 'invalid-tree-entry');
      if (typeof entry.path !== 'string' || !safePath(entry.path) || seen.has(entry.path)
        || typeof entry.mode !== 'string' || typeof entry.type !== 'string' || !validCommit(entry.sha)) {
        throw new GitHubClientError('invalid-tree-entry');
      }
      seen.add(entry.path);
      if (entry.size !== undefined && (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0)) {
        throw new GitHubClientError('invalid-tree-entry');
      }
      entries.push({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      });
    }
    checkOperation(context);
    return entries;
  }

  private treeFileMap(entries: readonly TreeEntry[], context: GitHubOperationContext): Map<string, TreeEntry> {
    const files = new Map<string, TreeEntry>();
    for (let index = 0; index < entries.length; index++) {
      if ((index & 255) === 0) checkOperation(context);
      const entry = entries[index]!;
      if (entry.type !== 'tree') files.set(entry.path, entry);
    }
    checkOperation(context);
    return files;
  }

  private async readBlob(
    repository: RepositoryLocation,
    entry: TreeEntry,
    token: string | undefined,
    maxFileBytes: number,
    context: GitHubOperationContext,
  ): Promise<SnapshotFile> {
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')
      || !safePath(entry.path) || !validCommit(entry.sha)) throw new GitHubClientError('unsupported-github-file-mode');
    if (entry.size !== undefined && entry.size > maxFileBytes) throw new GitHubClientError('github-file-limit');
    const raw = requiredRecord(await this.request(repoPath(repository, `/git/blobs/${entry.sha}`), {
      ...(token ? { token } : {}),
      maxResponseBytes: Math.min(MAX_REST_RESPONSE_BYTES, maxFileBytes * 2 + 128_000),
      context,
    }), 'invalid-github-blob');
    if (raw.sha !== entry.sha || raw.encoding !== 'base64' || typeof raw.content !== 'string'
      || typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > maxFileBytes) {
      throw new GitHubClientError('invalid-github-blob');
    }
    const bytes = decodeBase64(raw.content, true);
    if (bytes.byteLength !== raw.size || (entry.size !== undefined && bytes.byteLength !== entry.size)) {
      throw new GitHubClientError('github-blob-size-mismatch');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GitHubClientError('github-binary-file-rejected');
    }
    if (content.includes('\0') || !safePath(entry.path)) throw new GitHubClientError('github-binary-file-rejected');
    const mode = entry.mode === '100755' ? '100755' : '100644';
    return { path: entry.path, content, sizeBytes: bytes.byteLength, mode };
  }

  private async materializeFiles(
    repository: RepositoryLocation,
    entries: readonly TreeEntry[],
    token: string | undefined,
    maxFiles: number,
    maxFileBytes: number,
    maxBytes: number,
    context: GitHubOperationContext,
  ): Promise<SnapshotFile[]> {
    if (entries.length > maxFiles || entries.length > MAX_REQUESTS_PER_OPERATION) throw new GitHubClientError('snapshot-file-limit');
    let total = 0;
    for (let index = 0; index < entries.length; index++) {
      if ((index & 255) === 0) checkOperation(context);
      const fileBytes = entries[index]!.size ?? 0;
      if (fileBytes > maxFileBytes) throw new GitHubClientError('github-file-limit');
      total += fileBytes;
    }
    if (total > maxBytes) throw new GitHubClientError('snapshot-byte-limit');
    const output: SnapshotFile[] = new Array(entries.length);
    let nextIndex = 0;
    let actualBytes = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        checkOperation(context);
        const index = nextIndex++;
        if (index >= entries.length) return;
        const file = await this.readBlob(repository, entries[index]!, token, maxFileBytes, context);
        actualBytes += file.sizeBytes;
        if (actualBytes > maxBytes) throw new GitHubClientError('snapshot-byte-limit');
        output[index] = file;
        checkOperation(context);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, () => worker()));
    if (actualBytes > maxBytes) throw new GitHubClientError('snapshot-byte-limit');
    checkOperation(context);
    return output;
  }

  async readSourceSnapshot(input: {
    plan: PinnedPlan;
    paths: readonly string[];
    maxFiles: number;
    maxFileBytes: number;
    maxBytes: number;
    maxJobSeconds: number;
  }): Promise<SourceSnapshot> {
    if (!Number.isSafeInteger(input.maxFiles) || input.maxFiles < 1 || input.maxFiles > MAX_TREE_ENTRIES
      || !Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxFileBytes > input.maxBytes
      || !Number.isFinite(input.maxJobSeconds) || input.maxJobSeconds <= 0
      || !Array.isArray(input.paths) || input.paths.length > input.maxFiles
      || !Array.isArray(input.plan.changedFiles) || input.plan.changedFiles.length > 5_000) {
      throw new GitHubClientError('invalid-source-snapshot-request');
    }
    const requested = new Set(input.paths);
    const changeByPath = new Map<string, UpstreamChangedFile['status']>();
    for (const change of input.plan.changedFiles) {
      if (!change || typeof change.path !== 'string' || !safePath(change.path)
        || (change.status !== 'added' && change.status !== 'modified' && change.status !== 'deleted')
        || changeByPath.has(change.path)) throw new GitHubClientError('invalid-source-change-classification');
      changeByPath.set(change.path, change.status);
    }
    if (requested.size !== input.paths.length || [...requested].some(path => typeof path !== 'string' || !safePath(path)
      || !changeByPath.has(path))) throw new GitHubClientError('invalid-source-path-set');

    let requiredBlobReads = 0;
    for (const path of requested) {
      const status = changeByPath.get(path);
      if (status === 'added' || status === 'deleted') requiredBlobReads++;
      else if (status === 'modified') requiredBlobReads += 2;
      else throw new GitHubClientError('invalid-source-change-classification');
    }
    const maxRequests = requiredBlobReads + SOURCE_REQUEST_OVERHEAD;
    if (!Number.isSafeInteger(maxRequests) || maxRequests > MAX_REQUESTS_PER_OPERATION) {
      throw new GitHubClientError('source-snapshot-request-limit');
    }
    const context = createOperationContext(
      input.maxJobSeconds,
      Math.min(64_000_000, input.maxBytes * 2 + MAX_TREE_RESPONSE_BYTES + 2_000_000),
      maxRequests,
    );
    const repository = parseRepositoryUrl(input.plan.upstreamRepository);
    if ([...requested].some(path => matchesAny(path, [...INTERNAL_PATHS, ...DEFAULT_PROTECTED_PATHS, ...SENSITIVE_PATHS], context.globBudget))) {
      throw new GitHubClientError('invalid-source-path-set');
    }
    const token = await this.resolveUpstreamReadToken(input.plan.installationId, repository, context);
    const beforeCommit = await this.getCommit(repository, input.plan.fromCommit, token, context);
    const afterCommit = await this.getCommit(repository, input.plan.toCommit, token, context);
    if (beforeCommit.sha.toLowerCase() !== input.plan.fromCommit.toLowerCase()
      || afterCommit.sha.toLowerCase() !== input.plan.toCommit.toLowerCase()) {
      throw new GitHubClientError('source-commit-mismatch');
    }
    const beforeTree = this.treeFileMap(await this.getTree(repository, beforeCommit.treeSha, token, context), context);
    const afterTree = this.treeFileMap(await this.getTree(repository, afterCommit.treeSha, token, context), context);
    const beforeEntries: TreeEntry[] = [];
    const afterEntries: TreeEntry[] = [];
    const deletedPaths: string[] = [];
    for (const path of requested) {
      checkOperation(context);
      const status = changeByPath.get(path);
      const before = beforeTree.get(path);
      const after = afterTree.get(path);
      if (status === 'added') {
        if (before || !after) throw new GitHubClientError('source-change-classification-mismatch');
        afterEntries.push(after);
      } else if (status === 'modified') {
        if (!before || !after) throw new GitHubClientError('source-change-classification-mismatch');
        beforeEntries.push(before);
        afterEntries.push(after);
      } else if (status === 'deleted') {
        if (!before || after) throw new GitHubClientError('source-change-classification-mismatch');
        beforeEntries.push(before);
        deletedPaths.push(path);
      } else {
        throw new GitHubClientError('invalid-source-path-set');
      }
    }
    if (requested.size > input.maxFiles) throw new GitHubClientError('snapshot-file-limit');
    const estimatedBytes = [...beforeEntries, ...afterEntries].reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (estimatedBytes > input.maxBytes) throw new GitHubClientError('snapshot-byte-limit');
    const beforeFiles = await this.materializeFiles(repository, beforeEntries, token, input.maxFiles, input.maxFileBytes, input.maxBytes, context);
    const files = await this.materializeFiles(repository, afterEntries, token, input.maxFiles, input.maxFileBytes, input.maxBytes, context);
    const actualBytes = [...beforeFiles, ...files].reduce((sum, file) => sum + file.sizeBytes, 0);
    if (actualBytes > input.maxBytes) {
      throw new GitHubClientError('snapshot-byte-limit');
    }
    checkOperation(context);
    return {
      repository: input.plan.upstreamRepository,
      beforeCommit: input.plan.fromCommit,
      beforeFiles,
      commit: input.plan.toCommit,
      files,
      deletedPaths,
    };
  }

  async readTargetSnapshot(input: {
    plan: PinnedPlan;
    pathPatterns: readonly string[];
    excludedPathPatterns: readonly string[];
    maxFiles: number;
    maxFileBytes: number;
    maxBytes: number;
    maxJobSeconds: number;
  }): Promise<TargetSnapshot> {
    const context = createOperationContext(
      input.maxJobSeconds,
      Math.min(64_000_000, input.maxBytes * 2 + MAX_TREE_RESPONSE_BYTES + 2_000_000),
      Math.min(MAX_REQUESTS_PER_OPERATION, input.maxFiles + MAX_INSTALLATION_REPOSITORY_PAGES + 20),
    );
    const repository: RepositoryLocation = { ...input.plan.target };
    const token = await this.tokenForRepository(input.plan.installationId, repository, context);
    const commit = await this.getCommit(repository, input.plan.targetBaseCommit, token, context);
    const tree = await this.getTree(repository, commit.treeSha, token, context);
    const selected: TreeEntry[] = [];
    for (const entry of tree) {
      checkOperation(context);
      if (entry.type === 'tree') continue;
      if (!matchesAny(entry.path, input.pathPatterns, context.globBudget)
        || matchesAny(entry.path, input.excludedPathPatterns, context.globBudget)) continue;
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw new GitHubClientError('unsupported-target-entry');
      }
      selected.push(entry);
      if (selected.length > input.maxFiles) throw new GitHubClientError('snapshot-file-limit');
    }
    const files = await this.materializeFiles(repository, selected, token, input.maxFiles, input.maxFileBytes, input.maxBytes, context);
    return {
      repository: { ...input.plan.target },
      baseBranch: input.plan.baseBranch,
      commit: input.plan.targetBaseCommit,
      existingPaths: files.map(file => file.path),
      files,
    };
  }

  async readTargetWorkspace(input: TargetWorkspaceReadInput): Promise<TargetWorkspaceSnapshot> {
    const context = createOperationContext(
      input.maxJobSeconds,
      Math.min(64_000_000, input.maxBytes * 2 + MAX_TREE_RESPONSE_BYTES + 2_000_000),
      Math.min(MAX_REQUESTS_PER_OPERATION, input.maxFiles + MAX_INSTALLATION_REPOSITORY_PAGES + 20),
    );
    if (!validRepository(input.target) || !validCommit(input.commit)
      || !Number.isSafeInteger(input.maxFiles) || input.maxFiles < 1 || input.maxFiles > MAX_TREE_ENTRIES
      || !Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1 || input.maxFileBytes > input.maxBytes
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1
      || !Number.isSafeInteger(input.maxDirectories) || input.maxDirectories < 1 || input.maxDirectories > 100_000
      || !Number.isSafeInteger(input.maxPathBytes) || input.maxPathBytes < 1 || input.maxPathBytes > 4_096
      || !Number.isSafeInteger(input.maxPathDepth) || input.maxPathDepth < 1 || input.maxPathDepth > 256
      || !Number.isFinite(input.maxJobSeconds) || input.maxJobSeconds <= 0
      || !Array.isArray(input.excludedPathPatterns) || input.excludedPathPatterns.length > 1_000
      || input.excludedPathPatterns.some((pattern, index) => {
        if ((index & 63) === 0) checkOperation(context);
        return !safePath(pattern);
      })) {
      throw new GitHubClientError('invalid-workspace-request');
    }
    checkOperation(context);
    const repository: RepositoryLocation = { ...input.target };
    const token = await this.tokenForRepository(input.installationId, repository, context);
    const commit = await this.getCommit(repository, input.commit, token, context);
    const tree = await this.getTree(repository, commit.treeSha, token, context);
    const excluded = [
      ...INTERNAL_PATHS,
      ...DEFAULT_PROTECTED_PATHS,
      ...SENSITIVE_PATHS,
      ...input.excludedPathPatterns,
    ];
    const files: TreeEntry[] = [];
    const directories = new Set<string>();
    for (const entry of tree) {
      checkOperation(context);
      if (entry.type === 'tree' || matchesAny(entry.path, excluded, context.globBudget)) continue;
      if (new TextEncoder().encode(entry.path).byteLength > input.maxPathBytes || entry.path.split('/').length > input.maxPathDepth) {
        throw new GitHubClientError('workspace-path-limit');
      }
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw new GitHubClientError('unsupported-workspace-entry');
      }
      const parts = entry.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        directories.add(parts.slice(0, index).join('/'));
        if (directories.size > input.maxDirectories) throw new GitHubClientError('workspace-directory-limit');
      }
      files.push(entry);
      if (files.length > input.maxFiles) throw new GitHubClientError('workspace-file-limit');
    }
    return {
      repository: { ...input.target },
      commit: input.commit,
      files: await this.materializeFiles(repository, files, token, input.maxFiles, input.maxFileBytes, input.maxBytes, context),
    };
  }

  async readVerificationWorkspace(input: {
    plan: PinnedPlan;
    excludedPathPatterns: readonly string[];
    limits: VerificationWorkspaceLimits;
    maxJobSeconds: number;
  }): Promise<VerificationWorkspaceSnapshot> {
    const { limits } = input;
    if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > MAX_TREE_ENTRIES
      || !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
      || !Number.isSafeInteger(limits.maxDirectories) || limits.maxDirectories < 1
      || !Number.isSafeInteger(limits.maxPathBytes) || limits.maxPathBytes < 1
      || !Number.isSafeInteger(limits.maxPathDepth) || limits.maxPathDepth < 1
      || !Number.isSafeInteger(limits.maxSerializedBytes) || limits.maxSerializedBytes < 1) {
      throw new GitHubClientError('invalid-verification-workspace-limits');
    }
    const snapshot = await this.readTargetWorkspace({
      installationId: input.plan.installationId,
      target: input.plan.target,
      commit: input.plan.targetBaseCommit,
      excludedPathPatterns: input.excludedPathPatterns,
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxBytes: limits.maxBytes,
      maxDirectories: limits.maxDirectories,
      maxPathBytes: limits.maxPathBytes,
      maxPathDepth: limits.maxPathDepth,
      maxJobSeconds: input.maxJobSeconds,
    });
    const directories = new Set<string>();
    for (const file of snapshot.files) {
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        directories.add(parts.slice(0, index).join('/'));
        if (directories.size > limits.maxDirectories) throw new GitHubClientError('workspace-directory-limit');
      }
    }
    const workspace: VerificationWorkspaceSnapshot = {
      complete: true,
      repository: snapshot.repository,
      baseBranch: input.plan.baseBranch,
      commit: snapshot.commit,
      existingPaths: snapshot.files.map(file => file.path),
      files: snapshot.files,
    };
    if (new TextEncoder().encode(JSON.stringify(workspace)).byteLength > limits.maxSerializedBytes) {
      throw new GitHubClientError('verification-workspace-serialized-limit');
    }
    return workspace;
  }

  async publishDraft(input: DraftPublicationRequest): Promise<DraftPublication> {
    const { registration, plan, proposal } = input;
    const policy = parsePolicy(registration.policy);
    const context = createOperationContext(
      policy.limits.maxJobSeconds,
      Math.min(64_000_000, MAX_TREE_RESPONSE_BYTES * 4 + policy.limits.maxResponseBytes * 2),
      Math.min(MAX_REQUESTS_PER_OPERATION, policy.limits.maxFiles * 4 + MAX_INSTALLATION_REPOSITORY_PAGES + MAX_OPEN_PR_LIST_PAGES + 32),
    );
    if (!registration.active || registration.id !== plan.trackingId || registration.installationId !== plan.installationId
      || !validRepository(registration.target) || !sameRepositoryName(registration.target.fullName, plan.target.fullName)
      || registration.baseBranch !== plan.baseBranch || registration.policyHash !== plan.policyHash
      || input.idempotencyKey !== plan.jobKey || proposal.checkpointCandidate.jobId !== plan.jobId
      || proposal.checkpointCandidate.jobKey !== plan.jobKey || proposal.checkpointCandidate.trackingId !== registration.id
      || proposal.checkpointCandidate.upstreamCommit !== plan.toCommit
      || proposal.checkpointCandidate.targetBaseCommit !== plan.targetBaseCommit
      || proposal.checkpointCandidate.policyHash !== plan.policyHash
      || proposal.checkpointCandidate.expectedLastCheckedCommit !== plan.expectedLastCheckedCommit
      || proposal.checkpointCandidate.expectedLastSyncedCommit !== registration.lastSyncedCommit
      || proposal.verification.status !== 'passed' || proposal.verification.failureCode !== undefined) {
      throw new GitHubClientError('publication-contract-mismatch');
    }
    if (await policyHash(policy) !== registration.policyHash) throw new GitHubClientError('publication-policy-mismatch');
    await this.validateVerifiedProposal(input, policy, context);

    const repository: RepositoryLocation = { ...registration.target };
    const token = await this.tokenForRepository(registration.installationId, repository, context, 'publish');
    const branch = expectedJobBranch(input.idempotencyKey);
    await this.getBranch(repository, registration.baseBranch, token, context);
    const existingPr = await this.findExistingPullRequest(repository, registration, branch, token, context);
    if (existingPr) {
      const publication = await this.recoverPullRequest(existingPr, repository, registration, plan, proposal, branch, token, context);
      if (existingPr.merged) return publication;
      await this.assertFreshBase(repository, registration, plan, token, context);
      return publication;
    }
    await this.assertFreshBase(repository, registration, plan, token, context);
    await this.assertNoOtherOpenTrackedPullRequests(repository, registration, branch, token, context);

    const baseCommit = await this.getCommit(repository, plan.targetBaseCommit, token, context);
    const baseTree = await this.getTree(repository, baseCommit.treeSha, token, context);
    const baseByPath = this.treeFileMap(baseTree, context);
    const branchTip = await this.getRef(repository, branch, token, context);
    if (branchTip) {
      await this.verifyOwnedBranch(branchTip, repository, registration, plan, proposal, branch, token, context, baseTree);
    } else {
      const commitSha = await this.createJobCommit(repository, registration, plan, proposal, branch, token, context, baseCommit.treeSha, baseByPath);
      try {
        const created = requiredRecord(await this.request(repoPath(repository, '/git/refs'), {
          method: 'POST',
          token,
          body: { ref: `refs/heads/${branch}`, sha: commitSha },
          maxResponseBytes: 256_000,
          context,
        }), 'invalid-created-ref');
        const object = requiredRecord(created.object, 'invalid-created-ref');
        if (objectSha(object, 'created-ref') !== commitSha) throw new GitHubClientError('created-ref-mismatch');
      } catch (error) {
        const recovered = await this.getRef(repository, branch, token, context).catch(() => undefined);
        if (!recovered) throw error;
        await this.verifyOwnedBranch(recovered, repository, registration, plan, proposal, branch, token, context, baseTree);
      }
    }

    const ownedTip = await this.getRef(repository, branch, token, context);
    if (!ownedTip) throw new GitHubClientError('publication-branch-missing');
    await this.verifyOwnedBranch(ownedTip, repository, registration, plan, proposal, branch, token, context, baseTree);
    await this.assertFreshBase(repository, registration, plan, token, context);
    await this.assertNoOtherOpenTrackedPullRequests(repository, registration, branch, token, context);
    const racedPr = await this.findExistingPullRequest(repository, registration, branch, token, context);
    if (racedPr) return this.recoverPullRequest(racedPr, repository, registration, plan, proposal, branch, token, context);

    const reportSummary = cleanText(proposal.report.summary, 8_000);
    const body = [
      'This is an automatically prepared **draft**. It has not been merged.',
      '',
      `**Summary:** ${reportSummary}`,
      '',
      `Upstream commit: \`${plan.toCommit}\``,
      `Policy fingerprint: \`${plan.policyHash}\``,
      `Job: \`${plan.jobKey}\``,
    ].join('\n');
    try {
      const created = parsePullRequest(await this.request(repoPath(repository, '/pulls'), {
        method: 'POST',
        token,
        body: { title: `Tracked upstream update ${plan.toCommit.slice(0, 7)}`, head: branch, base: registration.baseBranch, body, draft: true },
        maxResponseBytes: 1_000_000,
        context,
      }));
      return this.validatePullRequestPublication(created, repository, registration, branch, ownedTip, plan.targetBaseCommit);
    } catch (error) {
      const recovered = await this.findExistingPullRequest(repository, registration, branch, token, context).catch(() => undefined);
      if (!recovered) throw error;
      return this.recoverPullRequest(recovered, repository, registration, plan, proposal, branch, token, context);
    }
  }

  private async validateVerifiedProposal(
    input: DraftPublicationRequest,
    policy: ReturnType<typeof parsePolicy>,
    context: GitHubOperationContext,
  ): Promise<void> {
    const { plan, proposal } = input;
    const edits = proposal.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > policy.limits.maxFiles
      || !Array.isArray(proposal.report.decisions) || proposal.report.decisions.length !== plan.selectedSelectionIds.length
      || typeof proposal.report.summary !== 'string' || !proposal.report.summary.trim()
      || new TextEncoder().encode(proposal.report.summary).length > 20_000
      || proposal.verification.workspaceFiles.length > policy.limits.maxFiles) {
      throw new GitHubClientError('invalid-publication-proposal');
    }
    let boundedResponseBytes = new TextEncoder().encode(proposal.report.summary).length;
    const decisions = new Map<string, string>();
    for (const decision of proposal.report.decisions) {
      checkOperation(context);
      if (!plan.selectedSelectionIds.includes(decision.selection) || decisions.has(decision.selection)
        || !['applied', 'skipped'].includes(decision.status) || typeof decision.reason !== 'string'
        || !decision.reason.trim() || new TextEncoder().encode(decision.reason).length > 20_000) {
        throw new GitHubClientError('invalid-publication-report');
      }
      boundedResponseBytes += new TextEncoder().encode(decision.reason).length + 64;
      decisions.set(decision.selection, decision.status);
    }
    if (decisions.size !== plan.selectedSelectionIds.length) throw new GitHubClientError('invalid-publication-report');
    const editPaths = new Set<string>();
    const selectionEdits = new Set<string>();
    for (const edit of edits) {
      checkOperation(context);
      if (!safePath(edit.path) || editPaths.has(edit.path) || isProtectedOrSensitive(edit.path, policy, context.globBudget)) {
        throw new GitHubClientError('invalid-publication-edit');
      }
      editPaths.add(edit.path);
      if (edit.operation === 'write') {
        if (typeof edit.content !== 'string' || new TextEncoder().encode(edit.content).length > policy.limits.maxFileBytes) {
          throw new GitHubClientError('invalid-publication-edit');
        }
        boundedResponseBytes += new TextEncoder().encode(edit.content).length + new TextEncoder().encode(edit.path).length + 64;
        utf8Bytes(edit.content);
      } else if (edit.operation !== 'delete' || Object.hasOwn(edit, 'content')) {
        throw new GitHubClientError('invalid-publication-edit');
      } else {
        boundedResponseBytes += new TextEncoder().encode(edit.path).length + 64;
      }
      const matching = policy.selections.filter(selection => plan.selectedSelectionIds.includes(selection.id)
        && matchesAny(edit.path, selection.targetPaths, context.globBudget));
      if (!matching.length || !matching.some(selection => decisions.get(selection.id) === 'applied')
        || matching.some(selection => decisions.get(selection.id) === 'skipped')) {
        throw new GitHubClientError('publication-edit-out-of-scope');
      }
      for (const selection of matching) if (decisions.get(selection.id) === 'applied') selectionEdits.add(selection.id);
    }
    if (boundedResponseBytes > policy.limits.maxResponseBytes) throw new GitHubClientError('publication-response-limit');
    for (const [id, decision] of decisions) if (decision === 'applied' && !selectionEdits.has(id)) {
      throw new GitHubClientError('publication-applied-selection-empty');
    }
    const evidence = new Map(proposal.verification.workspaceFiles.map(file => [file.path, file]));
    if (evidence.size !== edits.length || edits.some(edit => evidence.get(edit.path)?.operation !== edit.operation)) {
      throw new GitHubClientError('publication-verification-mismatch');
    }
    for (const edit of edits) {
      if (edit.operation !== 'write') continue;
      const expectedDigest = await sha256(edit.content!);
      checkOperation(context);
      if (evidence.get(edit.path)?.sha256 !== expectedDigest) throw new GitHubClientError('publication-verification-mismatch');
    }
    const verificationMs = proposal.verification.steps.reduce((sum, step) => sum + step.durationMs, 0);
    const verificationBytes = proposal.verification.steps.reduce((sum, step) => sum + step.stdoutBytes + step.stderrBytes, 0);
    if (proposal.verification.steps.length !== policy.verification.length
      || proposal.verification.steps.some((step, index) => step.index !== index || step.exitCode !== 0
        || !Number.isSafeInteger(step.durationMs) || step.durationMs < 0
        || step.durationMs > policy.verification[index]!.timeoutSeconds * 1_000
        || !Number.isSafeInteger(step.stdoutBytes) || !Number.isSafeInteger(step.stderrBytes)
        || step.stdoutBytes < 0 || step.stderrBytes < 0
        || step.stdoutBytes + step.stderrBytes > policy.limits.maxVerificationOutputBytes)
      || verificationMs > policy.limits.maxJobSeconds * 1_000
      || verificationBytes > policy.limits.maxVerificationOutputBytes
      || proposal.verification.workspaceFiles.some(file => file.operation === 'write'
        && (!/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || (file.mode !== '100644' && file.mode !== '100755')))) {
      throw new GitHubClientError('publication-verification-mismatch');
    }
  }

  private async assertFreshBase(
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    plan: PinnedPlan,
    token: string,
    context: GitHubOperationContext,
  ): Promise<void> {
    const fresh = await this.getBranch(repository, registration.baseBranch, token, context);
    if (fresh.toLowerCase() !== plan.targetBaseCommit.toLowerCase()) throw new GitHubClientError('stale-target-base');
  }

  private async getRef(
    repository: RepositoryLocation,
    branch: string,
    token: string,
    context: GitHubOperationContext,
  ): Promise<string | undefined> {
    try {
      const raw = requiredRecord(await this.request(repoPath(repository, `/git/ref/heads/${encodeURIComponent(branch)}`), {
        token,
        maxResponseBytes: 128_000,
        context,
      }), 'invalid-github-ref');
      const object = requiredRecord(raw.object, 'invalid-github-ref');
      if (object.type !== 'commit') throw new GitHubClientError('publication-ref-not-commit');
      return objectSha(object, 'publication-ref');
    } catch (error) {
      if (error instanceof GitHubClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async createJobCommit(
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    plan: PinnedPlan,
    proposal: DraftPublicationRequest['proposal'],
    branch: string,
    token: string,
    context: GitHubOperationContext,
    baseTreeSha: string,
    baseByPath: ReadonlyMap<string, TreeEntry>,
  ): Promise<string> {
    const treeEntries: Array<{ path: string; mode: '100644' | '100755'; type: 'blob'; sha: string | null }> = [];
    for (const edit of proposal.edits) {
      checkOperation(context);
      const existing = baseByPath.get(edit.path);
      if (existing && (existing.type !== 'blob' || (existing.mode !== '100644' && existing.mode !== '100755'))) {
        throw new GitHubClientError('publication-base-entry-unsupported');
      }
      if (edit.operation === 'delete') {
        if (!existing) throw new GitHubClientError('publication-delete-target-missing');
        const mode = existing.mode === '100755' ? '100755' : '100644';
        treeEntries.push({ path: edit.path, mode, type: 'blob', sha: null });
        continue;
      }
      const bytes = utf8Bytes(edit.content!);
      const blob = requiredRecord(await this.request(repoPath(repository, '/git/blobs'), {
        method: 'POST',
        token,
        body: { content: edit.content, encoding: 'utf-8' },
        maxResponseBytes: 128_000,
        context,
      }), 'invalid-created-blob');
      const blobSha = requiredString(blob.sha, 'invalid-created-blob');
      if (!validCommit(blobSha) || (typeof blob.size === 'number' && blob.size !== bytes.byteLength)) {
        throw new GitHubClientError('created-blob-mismatch');
      }
      treeEntries.push({ path: edit.path, mode: existing?.mode === '100755' ? '100755' : '100644', type: 'blob', sha: blobSha });
    }
    const tree = requiredRecord(await this.request(repoPath(repository, '/git/trees'), {
      method: 'POST',
      token,
      body: { base_tree: baseTreeSha, tree: treeEntries },
      maxResponseBytes: 128_000,
      context,
    }), 'invalid-created-tree');
    const treeSha = requiredString(tree.sha, 'invalid-created-tree');
    if (!validCommit(treeSha)) throw new GitHubClientError('invalid-created-tree');
    const message = [
      `chore: prepare tracked upstream update ${plan.toCommit.slice(0, 7)}`,
      '',
      branchMarker(plan.jobKey),
      `oc-port-agent-upstream: ${plan.toCommit}`,
      `oc-port-agent-policy: ${plan.policyHash}`,
      `oc-port-agent-target-base: ${plan.targetBaseCommit}`,
    ].join('\n');
    const commit = requiredRecord(await this.request(repoPath(repository, '/git/commits'), {
      method: 'POST',
      token,
      body: {
        message,
        tree: treeSha,
        parents: [plan.targetBaseCommit],
        author: { name: 'oc-port-agent', email: 'oc-port-agent@users.noreply.github.com' },
        committer: { name: 'oc-port-agent', email: 'oc-port-agent@users.noreply.github.com' },
      },
      maxResponseBytes: 256_000,
      context,
    }), 'invalid-created-commit');
    const commitSha = requiredString(commit.sha, 'invalid-created-commit');
    if (!validCommit(commitSha) || commit.tree === undefined || objectSha(commit.tree, 'created-commit-tree') !== treeSha
      || !Array.isArray(commit.parents) || commit.parents.length !== 1
      || objectSha(commit.parents[0], 'created-commit-parent') !== plan.targetBaseCommit) {
      throw new GitHubClientError('created-commit-mismatch');
    }
    if (!registration.active) throw new GitHubClientError('inactive-registration');
    return commitSha;
  }

  private async getCommitMetadata(
    repository: RepositoryLocation,
    commitSha: string,
    token: string,
    context: GitHubOperationContext,
  ): Promise<CommitMetadata> {
    const raw = requiredRecord(await this.request(repoPath(repository, `/git/commits/${commitSha}`), {
      token,
      maxResponseBytes: 1_000_000,
      context,
    }), 'invalid-git-commit');
    if (!validCommit(raw.sha) || raw.sha.toLowerCase() !== commitSha.toLowerCase()
      || !Array.isArray(raw.parents) || typeof raw.message !== 'string') throw new GitHubClientError('invalid-git-commit');
    const treeSha = objectSha(raw.tree, 'git-commit-tree');
    const parents = raw.parents.map(value => objectSha(value, 'git-commit-parent'));
    return { sha: raw.sha, treeSha, message: raw.message, parents };
  }

  private async verifyOwnedBranch(
    branchSha: string,
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    plan: PinnedPlan,
    proposal: DraftPublicationRequest['proposal'],
    branch: string,
    token: string,
    context: GitHubOperationContext,
    knownBaseTree?: readonly TreeEntry[],
  ): Promise<void> {
    const commit = await this.getCommitMetadata(repository, branchSha, token, context);
    const markerLines = new Set(commit.message.split('\n'));
    if (commit.parents.length !== 1 || commit.parents[0]!.toLowerCase() !== plan.targetBaseCommit.toLowerCase()
      || !markerLines.has(branchMarker(plan.jobKey))
      || !markerLines.has(`oc-port-agent-upstream: ${plan.toCommit}`)
      || !markerLines.has(`oc-port-agent-policy: ${plan.policyHash}`)
      || !markerLines.has(`oc-port-agent-target-base: ${plan.targetBaseCommit}`)
      || branch !== expectedJobBranch(plan.jobKey)) throw new GitHubClientError('publication-branch-owned-by-other-job');
    const baseCommit = await this.getCommitMetadata(repository, plan.targetBaseCommit, token, context);
    const baseTree = knownBaseTree ?? await this.getTree(repository, baseCommit.treeSha, token, context);
    const branchTree = await this.getTree(repository, commit.treeSha, token, context);
    const before = this.treeFileMap(baseTree, context);
    const after = this.treeFileMap(branchTree, context);
    const expected = new Map(proposal.edits.map(edit => [edit.path, edit]));
    let changedCount = 0;
    for (const [path, oldEntry] of before) {
      checkOperation(context);
      const newEntry = after.get(path);
      if (!newEntry || oldEntry.mode !== newEntry.mode || oldEntry.type !== newEntry.type || oldEntry.sha !== newEntry.sha) {
        changedCount++;
        if (!expected.has(path)) throw new GitHubClientError('publication-branch-diff-mismatch');
      }
    }
    for (const path of after.keys()) {
      checkOperation(context);
      if (!before.has(path)) {
        changedCount++;
        if (!expected.has(path)) throw new GitHubClientError('publication-branch-diff-mismatch');
      }
    }
    if (changedCount !== expected.size) {
      throw new GitHubClientError('publication-branch-diff-mismatch');
    }
    await this.verifyProposalFilesOnTree(repository, branchTree, proposal, token, context, 'publication-branch');
  }

  private async verifyProposalFilesOnTree(
    repository: RepositoryLocation,
    tree: readonly TreeEntry[],
    proposal: DraftPublicationRequest['proposal'],
    token: string,
    context: GitHubOperationContext,
    failurePrefix: string,
  ): Promise<void> {
    const after = this.treeFileMap(tree, context);
    for (const edit of proposal.edits) {
      checkOperation(context);
      const current = after.get(edit.path);
      if (edit.operation === 'delete') {
        if (current) throw new GitHubClientError(`${failurePrefix}-deletion-not-retained`);
        continue;
      }
      if (!current || current.type !== 'blob' || (current.mode !== '100644' && current.mode !== '100755')) {
        throw new GitHubClientError(`${failurePrefix}-write-not-retained`);
      }
      const evidence = proposal.verification.workspaceFiles.find(file => file.path === edit.path);
      if (!evidence || evidence.operation !== 'write' || evidence.mode !== current.mode) {
        throw new GitHubClientError(`${failurePrefix}-mode-mismatch`);
      }
      const materialized = await this.readBlob(
        repository,
        current,
        token,
        Math.max(1_000, new TextEncoder().encode(edit.content!).length),
        context,
      );
      if (materialized.content !== edit.content) throw new GitHubClientError(`${failurePrefix}-content-mismatch`);
    }
  }

  private async verifyMergedTree(
    repository: RepositoryLocation,
    mergeCommitSha: string,
    sourceHeadSha: string,
    proposal: DraftPublicationRequest['proposal'],
    token: string,
    context: GitHubOperationContext,
  ): Promise<CommitMetadata> {
    const mergeCommit = await this.getCommitMetadata(repository, mergeCommitSha, token, context);
    if (mergeCommit.sha.toLowerCase() !== mergeCommitSha.toLowerCase()) throw new GitHubClientError('merged-commit-sha-mismatch');
    let mergeBaseParent: string;
    if (mergeCommit.parents.length === 1) {
      mergeBaseParent = mergeCommit.parents[0]!;
    } else if (mergeCommit.parents.length === 2 && mergeCommit.parents.some(parent => parent.toLowerCase() === sourceHeadSha.toLowerCase())) {
      const baseParents = mergeCommit.parents.filter(parent => parent.toLowerCase() !== sourceHeadSha.toLowerCase());
      if (baseParents.length !== 1) throw new GitHubClientError('merged-commit-parent-ambiguous');
      mergeBaseParent = baseParents[0]!;
    } else {
      throw new GitHubClientError('merged-commit-parent-ambiguous');
    }
    const parentCommit = await this.getCommitMetadata(repository, mergeBaseParent, token, context);
    const baseTree = await this.getTree(repository, parentCommit.treeSha, token, context);
    const mergedTree = await this.getTree(repository, mergeCommit.treeSha, token, context);
    const before = this.treeFileMap(baseTree, context);
    const after = this.treeFileMap(mergedTree, context);
    const expectedPaths = new Set(proposal.edits.map(edit => edit.path));
    let changedCount = 0;
    for (const [path, oldEntry] of before) {
      checkOperation(context);
      const newEntry = after.get(path);
      if (!oldEntry || !newEntry || oldEntry.mode !== newEntry.mode || oldEntry.type !== newEntry.type || oldEntry.sha !== newEntry.sha) {
        changedCount++;
        if (!expectedPaths.has(path)) throw new GitHubClientError('merged-tree-diff-mismatch');
      }
    }
    for (const path of after.keys()) {
      checkOperation(context);
      if (!before.has(path)) {
        changedCount++;
        if (!expectedPaths.has(path)) throw new GitHubClientError('merged-tree-diff-mismatch');
      }
    }
    if (changedCount !== expectedPaths.size) {
      throw new GitHubClientError('merged-tree-diff-mismatch');
    }
    await this.verifyProposalFilesOnTree(repository, mergedTree, proposal, token, context, 'merged-tree');
    return mergeCommit;
  }

  private async findExistingPullRequest(
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    branch: string,
    token: string,
    context: GitHubOperationContext,
  ): Promise<PullRequestRecord | undefined> {
    const found: PullRequestRecord[] = [];
    for (let page = 1; page <= 3; page++) {
      const url = new URL(repoPath(repository, '/pulls'), API_ORIGIN);
      url.searchParams.set('state', 'all');
      url.searchParams.set('base', registration.baseBranch);
      url.searchParams.set('head', `${repository.owner}:${branch}`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const raw = await this.request(url.pathname + url.search, { token, maxResponseBytes: 2_000_000, context });
      if (!Array.isArray(raw)) throw new GitHubClientError('invalid-pull-request-list');
      for (const value of raw) {
        checkOperation(context);
        const pr = parsePullRequest(value);
        if (sameRepositoryName(pr.headRepository, repository.fullName) && pr.headRef === branch
          && sameRepositoryName(pr.baseRepository, repository.fullName) && pr.baseRef === registration.baseBranch) found.push(pr);
      }
      if (raw.length < 100) break;
      if (page === 3) throw new GitHubClientError('pull-request-pagination-limit');
    }
    if (found.length > 1) throw new GitHubClientError('duplicate-job-pull-requests');
    return found[0];
  }

  private async assertNoOtherOpenTrackedPullRequests(
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    currentBranch: string,
    token: string,
    context: GitHubOperationContext,
  ): Promise<void> {
    for (let page = 1; page <= MAX_OPEN_PR_LIST_PAGES; page++) {
      checkOperation(context);
      const url = new URL(repoPath(repository, '/pulls'), API_ORIGIN);
      url.searchParams.set('state', 'open');
      url.searchParams.set('base', registration.baseBranch);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const raw = await this.request(url.pathname + url.search, { token, maxResponseBytes: 4_000_000, context });
      if (!Array.isArray(raw)) throw new GitHubClientError('invalid-pull-request-list');
      for (const value of raw) {
        checkOperation(context);
        const pr = requiredRecord(value, 'invalid-pull-request-list-entry');
        const base = requiredRecord(pr.base, 'invalid-pull-request-list-entry');
        const head = requiredRecord(pr.head, 'invalid-pull-request-list-entry');
        const baseRepository = requiredRecord(base.repo, 'invalid-pull-request-list-entry');
        if (base.ref !== registration.baseBranch || typeof baseRepository.full_name !== 'string'
          || !sameRepositoryName(baseRepository.full_name, repository.fullName) || typeof head.ref !== 'string') {
          throw new GitHubClientError('invalid-pull-request-list-entry');
        }
        const trackedBranch = /^oc-port-agent-[a-f0-9]{64}$/i.test(head.ref);
        if (!trackedBranch || head.ref === currentBranch) continue;
        const headRepository = isRecord(head.repo) ? head.repo.full_name : undefined;
        if (typeof headRepository !== 'string') throw new GitHubClientError('tracked-pull-request-repository-ambiguous');
        if (sameRepositoryName(headRepository, repository.fullName)) {
          throw new GitHubClientError('other-tracked-pull-request-open');
        }
      }
      if (raw.length < 100) return;
      if (page === MAX_OPEN_PR_LIST_PAGES) throw new GitHubClientError('open-pull-request-list-truncated');
    }
  }

  private validatePullRequestPublication(
    pr: PullRequestRecord,
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    branch: string,
    headSha: string,
    expectedBaseSha: string,
  ): DraftPublication {
    if (pr.state !== 'open' || !pr.draft || pr.merged || pr.headRef !== branch
      || !sameRepositoryName(pr.headRepository, repository.fullName)
      || !sameRepositoryName(pr.baseRepository, repository.fullName) || pr.baseRef !== registration.baseBranch
      || pr.baseSha.toLowerCase() !== expectedBaseSha.toLowerCase()
      || pr.headSha.toLowerCase() !== headSha.toLowerCase()) {
      throw new GitHubClientError('existing-pull-request-mismatch');
    }
    let url: URL;
    try {
      url = new URL(pr.url);
    } catch {
      throw new GitHubClientError('existing-pull-request-mismatch');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
      || !url.pathname.toLowerCase().startsWith(`/${repository.fullName.toLowerCase()}/pull/`)) {
      throw new GitHubClientError('existing-pull-request-mismatch');
    }
    return { pullRequestNumber: pr.number, url: pr.url, headCommit: pr.headSha };
  }

  private async recoverPullRequest(
    pr: PullRequestRecord,
    repository: RepositoryLocation,
    registration: TrackingRegistration,
    plan: PinnedPlan,
    proposal: DraftPublicationRequest['proposal'],
    branch: string,
    token: string,
    context: GitHubOperationContext,
  ): Promise<DraftPublication> {
    if (pr.headRef !== branch || !sameRepositoryName(pr.headRepository, repository.fullName)
      || !sameRepositoryName(pr.baseRepository, repository.fullName) || pr.baseRef !== registration.baseBranch) {
      throw new GitHubClientError('existing-pull-request-mismatch');
    }
    await this.verifyOwnedBranch(pr.headSha, repository, registration, plan, proposal, branch, token, context);
    if (pr.merged) {
      if (!pr.mergeCommitSha) throw new GitHubClientError('merged-pull-request-missing-commit');
      return { pullRequestNumber: pr.number, url: pr.url, headCommit: pr.headSha };
    }
    if (pr.baseSha.toLowerCase() !== plan.targetBaseCommit.toLowerCase()) throw new GitHubClientError('stale-target-base');
    return this.validatePullRequestPublication(pr, repository, registration, branch, pr.headSha, plan.targetBaseCommit);
  }

  async confirmMergedCheckpoint(input: {
    registration: TrackingRegistration;
    candidate: CheckpointCandidate;
  }): Promise<VerifiedMergeObservation | undefined> {
    const { registration, candidate } = input;
    if (!registration.active || candidate.trackingId !== registration.id || candidate.policyHash !== registration.policyHash
      || !validCommit(candidate.upstreamCommit) || !validCommit(candidate.targetBaseCommit)
      || !validCommit(candidate.expectedLastCheckedCommit) || !validCommit(candidate.expectedLastSyncedCommit)
      || !/^job_[a-f0-9]{64}$/i.test(candidate.jobKey)
      || candidate.jobId !== candidate.jobKey) return undefined;
    const policy = parsePolicy(registration.policy);
    const context = createOperationContext(
      policy.limits.maxJobSeconds,
      Math.min(64_000_000, MAX_TREE_RESPONSE_BYTES * 4 + policy.limits.maxContextBytes * 2),
      Math.min(MAX_REQUESTS_PER_OPERATION, policy.limits.maxFiles * 4 + MAX_INSTALLATION_REPOSITORY_PAGES + 32),
    );
    if (!this.loadCheckpointEvidence) return undefined;
    const evidence = await this.loadCheckpointEvidence(candidate);
    checkOperation(context);
    if (!evidence || evidence.plan.jobId !== candidate.jobId || evidence.plan.jobKey !== candidate.jobKey
      || evidence.plan.trackingId !== registration.id || evidence.plan.installationId !== registration.installationId
      || !sameRepositoryName(evidence.plan.target.fullName, registration.target.fullName)
      || evidence.plan.baseBranch !== registration.baseBranch || evidence.plan.targetBaseCommit !== candidate.targetBaseCommit
      || evidence.plan.toCommit !== candidate.upstreamCommit || evidence.plan.policyHash !== candidate.policyHash
      || evidence.plan.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit
      || evidence.plan.upstreamRepository !== policy.upstream.repository || evidence.plan.upstreamRef !== policy.upstream.ref
      || (registration.lastSyncedCommit !== candidate.expectedLastSyncedCommit
        && registration.lastSyncedCommit !== candidate.upstreamCommit)
      || evidence.proposal.checkpointCandidate.jobId !== candidate.jobId
      || evidence.proposal.checkpointCandidate.jobKey !== candidate.jobKey
      || evidence.proposal.checkpointCandidate.trackingId !== candidate.trackingId
      || evidence.proposal.checkpointCandidate.upstreamCommit !== candidate.upstreamCommit
      || evidence.proposal.checkpointCandidate.targetBaseCommit !== candidate.targetBaseCommit
      || evidence.proposal.checkpointCandidate.policyHash !== candidate.policyHash
      || evidence.proposal.checkpointCandidate.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit
      || evidence.proposal.checkpointCandidate.expectedLastSyncedCommit !== candidate.expectedLastSyncedCommit) return undefined;
    try {
      await this.validateVerifiedProposal({
        registration,
        plan: evidence.plan,
        proposal: evidence.proposal,
        idempotencyKey: candidate.jobKey,
      }, policy, context);
    } catch {
      return undefined;
    }
    const repository: RepositoryLocation = { ...registration.target };
    const token = await this.tokenForRepository(registration.installationId, repository, context);
    const branch = expectedJobBranch(candidate.jobKey);
    const prs: PullRequestRecord[] = [];
    for (let page = 1; page <= 3; page++) {
      const url = new URL(repoPath(repository, '/pulls'), API_ORIGIN);
      url.searchParams.set('state', 'all');
      url.searchParams.set('base', registration.baseBranch);
      url.searchParams.set('head', `${repository.owner}:${branch}`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const values = await this.request(url.pathname + url.search, { token, maxResponseBytes: 2_000_000, context });
      if (!Array.isArray(values)) throw new GitHubClientError('invalid-pull-request-list');
      for (const value of values) {
        checkOperation(context);
        const pr = parsePullRequest(value);
        if (pr.headRef === branch && pr.baseRef === registration.baseBranch
          && sameRepositoryName(pr.headRepository, repository.fullName)
          && sameRepositoryName(pr.baseRepository, repository.fullName)) prs.push(pr);
      }
      if (values.length < 100) break;
      if (page === 3) throw new GitHubClientError('pull-request-pagination-limit');
    }
    if (prs.length !== 1) return undefined;
    const pr = prs[0]!;
    if (!pr.merged || !pr.mergeCommitSha || pr.headRef !== branch || pr.baseRef !== registration.baseBranch
      || !sameRepositoryName(pr.headRepository, repository.fullName) || !sameRepositoryName(pr.baseRepository, repository.fullName)) return undefined;
    const sourceCommit = await this.getCommitMetadata(repository, pr.headSha, token, context);
    const markers = new Set(sourceCommit.message.split('\n'));
    if (sourceCommit.parents.length !== 1 || sourceCommit.parents[0]!.toLowerCase() !== candidate.targetBaseCommit.toLowerCase()
      || !markers.has(branchMarker(candidate.jobKey))
      || !markers.has(`oc-port-agent-upstream: ${candidate.upstreamCommit}`)
      || !markers.has(`oc-port-agent-policy: ${candidate.policyHash}`)
      || !markers.has(`oc-port-agent-target-base: ${candidate.targetBaseCommit}`)) return undefined;
    await this.verifyOwnedBranch(
      pr.headSha,
      repository,
      registration,
      evidence.plan,
      evidence.proposal,
      branch,
      token,
      context,
    );
    await this.verifyMergedTree(repository, pr.mergeCommitSha, pr.headSha, evidence.proposal, token, context);
    const observedBaseCommit = await this.getBranch(repository, registration.baseBranch, token, context);
    const observedBase = await this.getCommitMetadata(repository, observedBaseCommit, token, context);
    const observedBaseTree = await this.getTree(repository, observedBase.treeSha, token, context);
    await this.verifyProposalFilesOnTree(repository, observedBaseTree, evidence.proposal, token, context, 'configured-base');
    const ancestry = await this.compareRelationship(repository, pr.mergeCommitSha, observedBaseCommit, token, context);
    if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.mergeBase.toLowerCase() !== pr.mergeCommitSha.toLowerCase()) return undefined;
    return {
      trackingId: registration.id,
      jobId: candidate.jobId,
      pullRequestNumber: pr.number,
      baseBranch: registration.baseBranch,
      upstreamCommit: candidate.upstreamCommit,
      targetBaseCommit: candidate.targetBaseCommit,
      observedBaseCommit,
      mergeCommit: pr.mergeCommitSha,
      observedAt: isoNow(this.now),
    };
  }

  async getPullRequestLifecycle(input: {
    registration: TrackingRegistration;
    candidate: CheckpointCandidate;
    pullRequestNumber: number;
  }): Promise<PullRequestLifecycle> {
    const { registration, candidate, pullRequestNumber } = input;
    const unknown: PullRequestLifecycle = { status: 'unknown' };
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1
      || !registration.active || candidate.trackingId !== registration.id
      || candidate.policyHash !== registration.policyHash
      || (candidate.expectedLastSyncedCommit !== registration.lastSyncedCommit
        && candidate.upstreamCommit !== registration.lastSyncedCommit)
      || !validCommit(candidate.upstreamCommit) || !validCommit(candidate.targetBaseCommit)
      || !validCommit(candidate.expectedLastCheckedCommit) || !validCommit(candidate.expectedLastSyncedCommit)
      || !/^job_[a-f0-9]{64}$/i.test(candidate.jobKey) || candidate.jobId !== candidate.jobKey) return unknown;
    try {
      const policy = parsePolicy(registration.policy);
      const context = createOperationContext(
        policy.limits.maxJobSeconds,
        Math.min(64_000_000, MAX_TREE_RESPONSE_BYTES * 4 + policy.limits.maxContextBytes * 2),
        Math.min(MAX_REQUESTS_PER_OPERATION, policy.limits.maxFiles * 4 + MAX_INSTALLATION_REPOSITORY_PAGES + MAX_OPEN_PR_LIST_PAGES + 32),
      );
      if (!this.loadCheckpointEvidence) return unknown;
      const evidence = await this.loadCheckpointEvidence(candidate);
      checkOperation(context);
      if (!evidence || evidence.plan.jobId !== candidate.jobId || evidence.plan.jobKey !== candidate.jobKey
        || evidence.plan.trackingId !== registration.id || evidence.plan.installationId !== registration.installationId
        || !sameRepositoryName(evidence.plan.target.fullName, registration.target.fullName)
        || evidence.plan.baseBranch !== registration.baseBranch || evidence.plan.targetBaseCommit !== candidate.targetBaseCommit
        || evidence.plan.fromCommit !== candidate.expectedLastSyncedCommit
        || evidence.plan.toCommit !== candidate.upstreamCommit || evidence.plan.policyHash !== candidate.policyHash
        || evidence.plan.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit
        || evidence.plan.upstreamRepository !== policy.upstream.repository || evidence.plan.upstreamRef !== policy.upstream.ref
        || evidence.proposal.checkpointCandidate.jobId !== candidate.jobId
        || evidence.proposal.checkpointCandidate.jobKey !== candidate.jobKey
        || evidence.proposal.checkpointCandidate.trackingId !== candidate.trackingId
        || evidence.proposal.checkpointCandidate.upstreamCommit !== candidate.upstreamCommit
        || evidence.proposal.checkpointCandidate.targetBaseCommit !== candidate.targetBaseCommit
        || evidence.proposal.checkpointCandidate.policyHash !== candidate.policyHash
        || evidence.proposal.checkpointCandidate.expectedLastCheckedCommit !== candidate.expectedLastCheckedCommit
        || evidence.proposal.checkpointCandidate.expectedLastSyncedCommit !== candidate.expectedLastSyncedCommit) return unknown;
      await this.validateVerifiedProposal({
        registration,
        plan: evidence.plan,
        proposal: evidence.proposal,
        idempotencyKey: candidate.jobKey,
      }, policy, context);

      const repository: RepositoryLocation = { ...registration.target };
      const branch = expectedJobBranch(candidate.jobKey);
      const token = await this.tokenForRepository(registration.installationId, repository, context, 'publish');
      const pr = parsePullRequest(await this.request(repoPath(repository, `/pulls/${pullRequestNumber}`), {
        token,
        maxResponseBytes: 1_000_000,
        context,
      }));
      checkOperation(context);
      if (pr.number !== pullRequestNumber || pr.headRef !== branch || pr.baseRef !== registration.baseBranch
        || !sameRepositoryName(pr.headRepository, repository.fullName)
        || !sameRepositoryName(pr.baseRepository, repository.fullName)) return unknown;

      if (pr.merged) {
        const observation = await this.confirmMergedCheckpoint(input);
        if (observation?.pullRequestNumber !== pullRequestNumber) return unknown;
        return { status: 'merged', observation };
      }
      await this.verifyOwnedBranch(
        pr.headSha,
        repository,
        registration,
        evidence.plan,
        evidence.proposal,
        branch,
        token,
        context,
      );
      if (pr.state === 'open') return { status: 'open', pullRequestNumber, observedAt: isoNow(this.now) };
      if (pr.state === 'closed') return { status: 'closed-unmerged', pullRequestNumber, observedAt: isoNow(this.now) };
      return unknown;
    } catch (error) {
      if (error instanceof GitHubClientError && error.retryable && error.retryAfterSeconds !== undefined) {
        return { status: 'unknown', retryAfterSeconds: error.retryAfterSeconds };
      }
      return unknown;
    }
  }
}

/** Verifies a GitHub webhook over the exact bounded request bytes. */
export async function verifyGitHubWebhookSignature(
  body: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader) || secret.length === 0) return false;
  const expected = Uint8Array.from(signatureHeader.slice(7).match(/.{2}/g)!, hex => Number.parseInt(hex, 16));
  const key = await crypto.subtle.importKey('raw', cryptoBuffer(new TextEncoder().encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key, cryptoBuffer(body)));
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

export async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new GitHubClientError('webhook-body-limit');
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new GitHubClientError('webhook-body-limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks);
}

export function parseVerifiedWebhookJson(body: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new GitHubClientError('invalid-webhook-utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubClientError('invalid-webhook-json');
  }
}

// Keep these types in the public adapter surface for callers composing the port.
export type { DraftPublicationRequest, PinnedPlan, VerifiedMergeObservation };
