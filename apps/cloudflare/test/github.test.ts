import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DraftPublicationRequest,
  PinnedPlan,
  RepositoryIdentity,
  TrackingRegistration,
  VerifiedJobProposal,
} from '../src/contracts.js';
import { DEFAULT_VERIFICATION_WORKSPACE_LIMITS } from '../src/contracts.js';
import { GitHubAppClient, type GitHubAppCredentials, verifyGitHubWebhookSignature } from '../src/github.js';
import { DEFAULT_LIMITS, parsePolicy, policyHash } from '../src/policy.js';

const target: RepositoryIdentity = { owner: 'target-org', name: 'target', fullName: 'target-org/target' };
const upstreamRepository = 'https://github.com/upstream-org/project.git';
const fromCommit = 'a'.repeat(40);
const upstreamCommit = 'b'.repeat(40);
const targetBaseCommit = 'c'.repeat(40);
const lastSyncedCommit = fromCommit;
const baseTreeSha = '1'.repeat(40);
const jobId = `job_${'f'.repeat(64)}`;
const timestampMs = Date.parse('2026-10-09T12:00:00.000Z');
type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function policyInput(limits: Partial<typeof DEFAULT_LIMITS> = {}): Record<string, unknown> {
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
    preserve: ['Keep target-only behavior.'],
    verification: [{ command: 'node', args: ['test.js'], timeoutSeconds: 10 }],
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}

let pem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)!.join('\n');
  pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function apiCredentials(): GitHubAppCredentials {
  return { appId: '12345', privateKey: pem };
}

function apiTokenResponse(repositories: readonly string[], token = 'ghs-test-installation-token'): unknown {
  return {
    token,
    expires_at: new Date(timestampMs + 3_600_000).toISOString(),
    repositories: repositories.map(full_name => ({ full_name })),
  };
}

const installationRepoIds = new Map<string, number>([
  [target.fullName, 101],
  ['upstream-org/project', 202],
  ['upstream-org/target', 303],
]);

function installationRepositoryInventory(fullNames: readonly string[] = [target.fullName]): unknown {
  return {
    total_count: fullNames.length,
    repositories: fullNames.map(fullName => ({ id: installationRepoIds.get(fullName) ?? 999, full_name: fullName })),
  };
}

function tokenResponseForBody(body: Record<string, unknown>): unknown {
  const ids = Array.isArray(body.repository_ids) ? body.repository_ids : [];
  const repositories = ids.map(id => [...installationRepoIds.entries()].find(([, repositoryId]) => repositoryId === id)?.[0] ?? 'unknown/unknown');
  return ids.length ? apiTokenResponse(repositories) : { token: 'ghs-installation-inventory-token', expires_at: new Date(timestampMs + 3_600_000).toISOString() };
}

function makeRegistration(policy: unknown, digest: string): TrackingRegistration {
  return {
    id: 'tracking_example',
    installationId: 23,
    target,
    baseBranch: 'main',
    upstream: { repository: upstreamRepository, ref: 'main', baselineCommit: fromCommit },
    policy,
    policyHash: digest,
    lastCheckedCommit: fromCommit,
    lastSyncedCommit,
    active: true,
    revision: 1,
  };
}

async function makeProposal(policyDigest: string, content = 'export const parser = true;'): Promise<DraftPublicationRequest> {
  const plan: PinnedPlan = {
    trackingId: 'tracking_example',
    installationId: 23,
    target,
    baseBranch: 'main',
    targetBaseCommit,
    upstreamRepository,
    upstreamRef: 'main',
    fromCommit,
    expectedLastCheckedCommit: fromCommit,
    toCommit: upstreamCommit,
    commitCount: 1,
    changedFiles: [{ path: 'src/parser.ts', status: 'modified' }],
    changedPaths: ['src/parser.ts'],
    checkedChangedPaths: ['src/parser.ts'],
    observedAt: new Date(timestampMs).toISOString(),
    jobId,
    jobKey: jobId,
    policyHash: policyDigest,
    selectedUpstreamPaths: ['src/parser.ts'],
    checkedSelectedUpstreamPaths: ['src/parser.ts'],
    selectedSelectionIds: ['parser'],
  };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const proposal: VerifiedJobProposal = {
    report: { summary: 'Port parser behavior', decisions: [{ selection: 'parser', status: 'applied', reason: 'The target helper changed.' }] },
    edits: [{ path: 'lib/parser.ts', operation: 'write', content }],
    verification: {
      status: 'passed',
      steps: [{ index: 0, exitCode: 0, durationMs: 100, stdoutBytes: 0, stderrBytes: 0 }],
      workspaceFiles: [{ path: 'lib/parser.ts', operation: 'write', sha256, mode: '100644' }],
    },
    checkpointCandidate: {
      trackingId: 'tracking_example',
      jobId,
      jobKey: jobId,
      upstreamCommit,
      targetBaseCommit,
      policyHash: policyDigest,
      expectedLastCheckedCommit: fromCommit,
      expectedLastSyncedCommit: lastSyncedCommit,
    },
  };
  return {
    registration: makeRegistration(parsePolicy(policyInput()), policyDigest),
    plan,
    proposal,
    idempotencyKey: jobId,
  };
}

class PublisherGitHubApi {
  readonly calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  readonly branch = `oc-port-agent-${'f'.repeat(64)}`;
  readonly prs: Array<Record<string, unknown>> = [];
  openPullsOverride?: Array<Record<string, unknown>>;
  openPullListCalls = 0;
  injectTrackedPrOnSecondOpenList = false;
  baseTree: Array<Record<string, unknown>> = [];
  mergedTreeOverride: Array<Record<string, unknown>> | undefined;
  mergeParentsOverride: string[] | undefined;
  baseSha = targetBaseCommit;
  branchSha: string | undefined;
  branchTreeSha: string | undefined;
  branchTree: Array<Record<string, unknown>> = [];
  branchCommitMessage = '';
  branchParents: string[] = [];
  blobContent = '';
  timeoutAfterPullCreate = false;
  failAfterRefCreate = false;
  existingBranchCommit?: { sha: string; tree: string; message: string; parents: string[] };

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    this.calls.push({ method, path: `${url.pathname}${url.search}`, ...(requestBody ? { body: requestBody } : {}) });
    if (url.origin !== 'https://api.github.com' || init?.redirect !== 'error') throw new Error('unexpected outbound request');

    if (url.pathname === '/app/installations/23/access_tokens' && method === 'POST') {
      return json(tokenResponseForBody(requestBody ?? {}));
    }
    if (url.pathname === '/installation/repositories') {
      return json(installationRepositoryInventory([target.fullName, 'upstream-org/project']));
    }
    if (url.pathname === '/repos/target-org/target/branches/main' && method === 'GET') {
      return json({ name: 'main', commit: { sha: this.baseSha } });
    }
    if (url.pathname.startsWith('/repos/target-org/target/compare/')) {
      const range = decodeURIComponent(url.pathname.split('/compare/')[1] ?? '');
      const [from, to] = range.split('...');
      const identical = from === to;
      return json({
        status: identical ? 'identical' : 'ahead',
        total_commits: identical ? 0 : 1,
        base_commit: { sha: from },
        merge_base_commit: { sha: from },
        commits: identical ? [] : [{ sha: to }],
        files: [],
      });
    }
    if (url.pathname === '/repos/target-org/target/pulls' && method === 'GET') {
      const head = url.searchParams.get('head');
      const state = url.searchParams.get('state');
      if (head) {
        return json(this.prs.filter(pr => {
          const rawHead = pr.head as Record<string, unknown>;
          return rawHead.ref === this.branch && head === `target-org:${this.branch}`
            && (state !== 'open' || pr.state === 'open');
        }));
      }
      this.openPullListCalls++;
      if (this.injectTrackedPrOnSecondOpenList && this.openPullListCalls === 2) {
        this.prs.push(this.pullRequest(31, '7'.repeat(40), true, false, `oc-port-agent-${'a'.repeat(64)}`));
      }
      const candidates = this.openPullsOverride ?? this.prs.filter(pr => pr.state === 'open');
      const page = Number(url.searchParams.get('page') ?? '1');
      return json(candidates.slice((page - 1) * 100, page * 100));
    }
    if (url.pathname === '/repos/target-org/target/pulls' && method === 'POST') {
      const head = requestBody?.head;
      const base = requestBody?.base;
      if (head !== this.branch || base !== 'main' || requestBody?.draft !== true) return json({ message: 'bad request' }, 400);
      const rawPr = this.pullRequest(this.prs.length + 17, this.branchSha ?? 'e'.repeat(40), true, false);
      this.prs.push(rawPr);
      if (this.timeoutAfterPullCreate) {
        this.timeoutAfterPullCreate = false;
        throw new Error('simulated timeout after side effect');
      }
      return json(rawPr, 201);
    }
    if (/^\/repos\/target-org\/target\/pulls\/\d+$/.test(url.pathname) && method === 'GET') {
      const number = Number(url.pathname.split('/').at(-1));
      const pr = this.prs.find(item => item.number === number);
      return pr ? json(pr) : json({ message: 'not found' }, 404);
    }
    if (url.pathname === '/repos/target-org/target/commits/' + targetBaseCommit && method === 'GET') {
      return json({ sha: targetBaseCommit, commit: { tree: { sha: baseTreeSha }, message: 'base commit' }, parents: [] });
    }
    if (url.pathname === `/repos/target-org/target/git/commits/${targetBaseCommit}` && method === 'GET') {
      return json({ sha: targetBaseCommit, tree: { sha: baseTreeSha }, message: 'base commit', parents: [] });
    }
    if (url.pathname === `/repos/target-org/target/git/trees/${baseTreeSha}` && method === 'GET') {
      return json({ sha: baseTreeSha, truncated: false, tree: this.baseTree });
    }
    if (url.pathname === `/repos/target-org/target/git/trees/${'2'.repeat(40)}` && method === 'GET') {
      return json({ sha: '2'.repeat(40), truncated: false, tree: this.branchTree });
    }
    if (url.pathname === `/repos/target-org/target/git/trees/${'6'.repeat(40)}` && method === 'GET') {
      return json({ sha: '6'.repeat(40), truncated: false, tree: this.mergedTreeOverride ?? this.branchTree });
    }
    if (url.pathname === `/repos/target-org/target/git/trees/${'7'.repeat(40)}` && method === 'GET') {
      return json({ sha: '7'.repeat(40), truncated: false, tree: this.baseTree });
    }
    if (url.pathname === `/repos/target-org/target/git/ref/heads/${this.branch}` && method === 'GET') {
      if (this.branchSha) return json({ object: { type: 'commit', sha: this.branchSha } });
      return json({ message: 'Not Found' }, 404);
    }
    if (url.pathname === '/repos/target-org/target/git/blobs' && method === 'POST') {
      this.blobContent = String(requestBody?.content ?? '');
      return json({ sha: '9'.repeat(40), size: new TextEncoder().encode(this.blobContent).length }, 201);
    }
    if (url.pathname === '/repos/target-org/target/git/trees' && method === 'POST') {
      const entries = Array.isArray(requestBody?.tree) ? requestBody.tree as Array<Record<string, unknown>> : [];
      this.branchTree = entries.filter(entry => entry.sha !== null).map(entry => ({ ...entry }));
      this.branchTreeSha = '2'.repeat(40);
      return json({ sha: this.branchTreeSha, truncated: false }, 201);
    }
    if (url.pathname === '/repos/target-org/target/git/commits' && method === 'POST') {
      this.branchCommitMessage = String(requestBody?.message ?? '');
      const tree = requestBody?.tree;
      if (typeof tree !== 'string') return json({ message: 'bad request' }, 400);
      const parents = Array.isArray(requestBody?.parents) ? requestBody.parents as string[] : [];
      this.branchParents = parents;
      this.branchSha = 'e'.repeat(40);
      return json({ sha: this.branchSha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) }, 201);
    }
    if (url.pathname === '/repos/target-org/target/git/refs' && method === 'POST') {
      if (this.branchSha && this.existingBranchCommit) return json({ message: 'already exists' }, 422);
      const sha = String(requestBody?.sha ?? '');
      if (!this.branchSha) this.branchSha = sha;
      if (this.failAfterRefCreate) {
        this.failAfterRefCreate = false;
        throw new Error('simulated ref timeout after side effect');
      }
      return json({ object: { type: 'commit', sha: this.branchSha } }, 201);
    }
    if (url.pathname.startsWith('/repos/target-org/target/git/commits/') && method === 'GET') {
      const sha = url.pathname.split('/').at(-1)!;
      if (sha === this.branchSha && this.branchTreeSha) {
        return json({ sha, tree: { sha: this.branchTreeSha }, message: this.branchCommitMessage, parents: this.branchParents.map(parent => ({ sha: parent })) });
      }
      if (this.existingBranchCommit && sha === this.existingBranchCommit.sha) {
        return json({ sha, tree: { sha: this.existingBranchCommit.tree }, message: this.existingBranchCommit.message, parents: this.existingBranchCommit.parents.map(parent => ({ sha: parent })) });
      }
      if (sha === targetBaseCommit) return json({ sha, tree: { sha: baseTreeSha }, message: 'base commit', parents: [] });
      if (sha === '8'.repeat(40) && this.branchSha) {
        const parents = this.mergeParentsOverride ?? [targetBaseCommit, this.branchSha];
        return json({ sha, tree: { sha: '6'.repeat(40) }, message: 'merge commit', parents: parents.map(parent => ({ sha: parent })) });
      }
      if (sha === '9'.repeat(40)) {
        return json({ sha, tree: { sha: '7'.repeat(40) }, message: 'later base commit', parents: [{ sha: '8'.repeat(40) }] });
      }
      if (sha === '8'.repeat(40) && this.branchSha) {
        return json({ sha, tree: { sha: '6'.repeat(40) }, message: 'merge commit', parents: [{ sha: targetBaseCommit }, { sha: this.branchSha }] });
      }
    }
    if (url.pathname.startsWith('/repos/target-org/target/git/blobs/') && method === 'GET') {
      const content = this.blobContent;
      const binary = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      return json({ sha: '9'.repeat(40), encoding: 'base64', size: new TextEncoder().encode(content).length, content: binary });
    }
    return json({ message: `unexpected route ${method} ${url.pathname}` }, 404);
  }

  pullRequest(number: number, headSha: string, draft: boolean, merged: boolean, branch = this.branch): Record<string, unknown> {
    return {
      number,
      state: merged ? 'closed' : 'open',
      draft,
      merged,
      merged_at: merged ? new Date(timestampMs).toISOString() : null,
      merge_commit_sha: merged ? '8'.repeat(40) : null,
      html_url: `https://github.com/${target.fullName}/pull/${number}`,
      base: { ref: 'main', sha: this.baseSha, repo: { full_name: target.fullName } },
      head: { ref: branch, sha: headSha, repo: { full_name: target.fullName } },
    };
  }
}

describe('GitHub App adapter', () => {
  it('signs App JWTs with WebCrypto and scopes short-lived tokens to exact repositories and permissions', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const tokenBodies: Array<{ repository_ids?: number[]; permissions: Record<string, string> }> = [];
    const fetcher = vi.fn<HttpFetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.pathname === '/app/installations/23/access_tokens') {
        const authorization = new Headers(init?.headers).get('Authorization') ?? '';
        const jwt = authorization.replace(/^Bearer /, '');
        const [header, payload, signed] = jwt.split('.');
        const unsigned = `${header}.${payload}`;
        const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, cryptoBuffer(decodeBase64Url(signed!)), new TextEncoder().encode(unsigned));
        expect(valid).toBe(true);
        const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload!))) as Record<string, unknown>;
        expect(claims.iss).toBe('12345');
        expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
        const body = JSON.parse(String(init?.body)) as { repository_ids?: number[]; permissions: Record<string, string> };
        tokenBodies.push(body);
        if (body.repository_ids?.length === 1 && body.repository_ids[0] === installationRepoIds.get(target.fullName)) {
          return json(apiTokenResponse([target.fullName]));
        }
        return json(tokenResponseForBody(body));
      }
      if (url.pathname === '/installation/repositories') {
        return json(installationRepositoryInventory([target.fullName, 'upstream-org/project']));
      }
      if (url.pathname === `/repos/${target.fullName}`) {
        return json({ full_name: target.fullName, private: true, permissions: { push: true } });
      }
      if (url.pathname === '/repos/upstream-org/project') {
        return json({ full_name: 'upstream-org/project', private: true, permissions: { pull: true } });
      }
      return json({ message: 'not found' }, 404);
    });
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const result = await client.verifyTrackingAccess({ installationId: 23, target, upstreamRepository });
    expect(result).toEqual({ targetAccessible: true, targetWritable: true, upstreamReadable: true });
    expect(tokenBodies).toEqual([
      { permissions: { metadata: 'read' } },
      { repository_ids: [101], permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } },
      { repository_ids: [202], permissions: { contents: 'read', metadata: 'read' } },
    ]);
    expect(requests.every(request => request.url.origin === 'https://api.github.com' && request.init?.redirect === 'error')).toBe(true);
    expect(requests.some(request => new Headers(request.init?.headers).get('Authorization') === 'Bearer ghs-test-installation-token')).toBe(true);
  });

  it('distinguishes authoritative permission denial from rate limits, 5xx, and transport failures', async () => {
    const makeClient = (failure: 'rate-403' | 'secondary-403' | '429' | '500' | 'denied-403' | 'network') => {
      const fetcher: HttpFetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/app/installations/23/access_tokens' && init?.method === 'POST') {
          return json(tokenResponseForBody(JSON.parse(String(init.body)) as Record<string, unknown>));
        }
        if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
        if (url.pathname === `/repos/${target.fullName}`) {
          if (failure === 'network') throw new Error('temporary transport failure');
          const status = failure === 'rate-403' || failure === 'secondary-403' || failure === 'denied-403'
            ? 403
            : failure === '429' ? 429 : 500;
          const headers = new Headers({ 'content-type': 'application/json' });
          if (failure === 'rate-403') {
            headers.set('x-ratelimit-remaining', '0');
            headers.set('x-ratelimit-reset', String(Math.floor(timestampMs / 1_000) + 45));
          }
          if (failure === 'secondary-403') headers.set('retry-after', '17');
          return new Response(JSON.stringify({ message: 'rate limited or denied' }), { status, headers });
        }
        return json({ message: 'not found' }, 404);
      };
      return new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    };
    const input = { installationId: 23, target, upstreamRepository };
    for (const failure of ['rate-403', 'secondary-403', '429', '500', 'network'] as const) {
      await expect(makeClient(failure).verifyTrackingAccess(input)).rejects.toMatchObject({ retryable: true });
    }
    await expect(makeClient('rate-403').verifyTrackingAccess(input)).rejects.toMatchObject({ status: 403, retryAfterSeconds: 45 });
    await expect(makeClient('secondary-403').verifyTrackingAccess(input)).rejects.toMatchObject({ status: 403, retryAfterSeconds: 17 });
    await expect(makeClient('denied-403').verifyTrackingAccess(input)).resolves.toMatchObject({
      targetAccessible: false,
      targetWritable: false,
      upstreamReadable: false,
    });
  });

  it('reads a public upstream anonymously through preflight, discovery, and source blobs, then fails closed after privatization', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const registration = makeRegistration(policy, digest);
    const sourceBlob = '7'.repeat(40);
    const previousSourceBlob = '8'.repeat(40);
    const content = '\uFEFFexport const parser = true;';
    const previousContent = 'export const parser = false;';
    const upstreamReads: Array<{ path: string; authorization: string | null }> = [];
    let upstreamPrivate = false;
    let blobReads = 0;
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.pathname === '/app/installations/23/access_tokens' && init?.method === 'POST') {
        return json(tokenResponseForBody(JSON.parse(String(init.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === `/repos/${target.fullName}`) return json({ full_name: target.fullName, private: true, permissions: { push: true } });
      if (url.pathname === '/repos/upstream-org/project') {
        upstreamReads.push({ path: url.pathname, authorization });
        return upstreamPrivate ? json({ message: 'Not Found' }, 404) : json({ full_name: 'upstream-org/project', private: false });
      }
      if (url.pathname === `/repos/upstream-org/project/commits/${fromCommit}`) {
        upstreamReads.push({ path: url.pathname, authorization });
        return json({ sha: fromCommit, commit: { tree: { sha: '5'.repeat(40) }, message: 'prior source commit' }, parents: [] });
      }
      if (url.pathname === '/repos/upstream-org/project/commits/main' || url.pathname === `/repos/upstream-org/project/commits/${upstreamCommit}`) {
        upstreamReads.push({ path: url.pathname, authorization });
        const sha = url.pathname.endsWith('/main') ? upstreamCommit : url.pathname.split('/').at(-1)!;
        return json({ sha, commit: { tree: { sha: '6'.repeat(40) }, message: 'source commit' }, parents: [] });
      }
      if (url.pathname.startsWith('/repos/upstream-org/project/compare/')) {
        upstreamReads.push({ path: url.pathname, authorization });
        const baseSha = url.pathname.split('/compare/')[1]!.split('...')[0]!;
        return json({
          status: 'ahead', total_commits: 1, ahead_by: 1, behind_by: 0,
          base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha },
          commits: [{ sha: upstreamCommit }],
          files: url.searchParams.get('per_page') === '100' ? [{ filename: 'src/parser.ts', status: 'modified' }] : [],
        });
      }
      if (url.pathname === '/repos/target-org/target/branches/main') return json({ name: 'main', commit: { sha: targetBaseCommit } });
      if (url.pathname === `/repos/upstream-org/project/git/trees/${'5'.repeat(40)}`) {
        upstreamReads.push({ path: url.pathname, authorization });
        return json({ sha: '5'.repeat(40), truncated: false, tree: [{
          path: 'src/parser.ts', mode: '100644', type: 'blob', sha: previousSourceBlob,
          size: new TextEncoder().encode(previousContent).length,
        }] });
      }
      if (url.pathname === `/repos/upstream-org/project/git/trees/${'6'.repeat(40)}`) {
        upstreamReads.push({ path: url.pathname, authorization });
        return json({ sha: '6'.repeat(40), truncated: false, tree: [{ path: 'src/parser.ts', mode: '100644', type: 'blob', sha: sourceBlob, size: new TextEncoder().encode(content).length }] });
      }
      if (url.pathname === `/repos/upstream-org/project/git/blobs/${previousSourceBlob}`) {
        blobReads++;
        upstreamReads.push({ path: url.pathname, authorization });
        const bytes = new TextEncoder().encode(previousContent);
        return json({ sha: previousSourceBlob, encoding: 'base64', size: bytes.length, content: btoa(String.fromCharCode(...bytes)) });
      }
      if (url.pathname === `/repos/upstream-org/project/git/blobs/${sourceBlob}`) {
        blobReads++;
        upstreamReads.push({ path: url.pathname, authorization });
        const bytes = new TextEncoder().encode(content);
        return json({ sha: sourceBlob, encoding: 'base64', size: bytes.length, content: btoa(String.fromCharCode(...bytes)) });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const access = await client.verifyTrackingAccess({ installationId: 23, target, upstreamRepository });
    expect(access).toEqual({ targetAccessible: true, targetWritable: true, upstreamReadable: true });
    await client.verifyRegistrationReferences({
      installationId: 23,
      target,
      baseBranch: 'main',
      upstreamRepository,
      upstreamRef: 'main',
      baselineCommit: fromCommit,
    });
    const plan = await client.discoverPlan(registration, policy);
    expect(plan?.toCommit).toBe(upstreamCommit);
    const pinnedPlan: PinnedPlan = {
      ...plan!,
      jobId,
      jobKey: jobId,
      policyHash: digest,
      selectedUpstreamPaths: ['src/parser.ts'],
      checkedSelectedUpstreamPaths: ['src/parser.ts'],
      selectedSelectionIds: ['parser'],
    };
    const source = await client.readSourceSnapshot({
      plan: pinnedPlan,
      paths: ['src/parser.ts'],
      maxFiles: 20,
      maxFileBytes: 10_000,
      maxBytes: 10_000,
      maxJobSeconds: 10,
    });
    expect(source.beforeCommit).toBe(fromCommit);
    expect(source.beforeFiles).toEqual([{
      path: 'src/parser.ts', content: previousContent,
      sizeBytes: new TextEncoder().encode(previousContent).length, mode: '100644',
    }]);
    expect(source.files).toEqual([{ path: 'src/parser.ts', content, sizeBytes: new TextEncoder().encode(content).length, mode: '100644' }]);
    expect(upstreamReads.length).toBeGreaterThan(0);
    expect(upstreamReads.every(request => request.authorization === null)).toBe(true);

    upstreamPrivate = true;
    const previousBlobReads = blobReads;
    await expect(client.readSourceSnapshot({
      plan: pinnedPlan,
      paths: ['src/parser.ts'],
      maxFiles: 20,
      maxFileBytes: 10_000,
      maxBytes: 10_000,
      maxJobSeconds: 10,
    })).rejects.toMatchObject({ code: 'upstream-read-access-denied' });
    expect(blobReads).toBe(previousBlobReads);
    const privateAccess = await client.verifyTrackingAccess({ installationId: 23, target, upstreamRepository });
    expect(privateAccess.upstreamReadable).toBe(false);
  });

  it('budgets REST reads for both pinned versions of modified files and mixed change classifications', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    let changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
    let beforeTree: Array<Record<string, unknown>> = [];
    let afterTree: Array<Record<string, unknown>> = [];
    const blobs = new Map<string, string>();
    const calls: string[] = [];
    const blobSha = async (key: string): Promise<string> => {
      const result = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
      return [...result].map(byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const setChanges = async (next: typeof changes): Promise<void> => {
      changes = next;
      beforeTree = [];
      afterTree = [];
      blobs.clear();
      for (const [index, change] of changes.entries()) {
        if (change.status !== 'added') {
          const sha = await blobSha(`before:${index}:${change.path}`);
          beforeTree.push({ path: change.path, mode: '100644', type: 'blob', sha, size: 1 });
          blobs.set(sha, 'o');
        }
        if (change.status !== 'deleted') {
          const sha = await blobSha(`after:${index}:${change.path}`);
          afterTree.push({ path: change.path, mode: '100644', type: 'blob', sha, size: 1 });
          blobs.set(sha, 'n');
        }
      }
    };
    const fetcher: HttpFetch = async (inputUrl, init) => {
      const url = new URL(inputUrl instanceof Request ? inputUrl.url : inputUrl.toString());
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/app/installations/23/access_tokens' && init?.method === 'POST') {
        return json(tokenResponseForBody(JSON.parse(String(init.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') {
        return json(installationRepositoryInventory([target.fullName, 'upstream-org/project']));
      }
      if (url.pathname === '/repos/upstream-org/project') {
        return json({ full_name: 'upstream-org/project', private: true, permissions: { pull: true } });
      }
      if (url.pathname === `/repos/upstream-org/project/commits/${fromCommit}`) {
        return json({ sha: fromCommit, commit: { tree: { sha: '5'.repeat(40) }, message: 'before' }, parents: [] });
      }
      if (url.pathname === `/repos/upstream-org/project/commits/${upstreamCommit}`) {
        return json({ sha: upstreamCommit, commit: { tree: { sha: '6'.repeat(40) }, message: 'after' }, parents: [] });
      }
      if (url.pathname === `/repos/upstream-org/project/git/trees/${'5'.repeat(40)}`) {
        return json({ sha: '5'.repeat(40), truncated: false, tree: beforeTree });
      }
      if (url.pathname === `/repos/upstream-org/project/git/trees/${'6'.repeat(40)}`) {
        return json({ sha: '6'.repeat(40), truncated: false, tree: afterTree });
      }
      if (url.pathname.startsWith('/repos/upstream-org/project/git/blobs/')) {
        const sha = url.pathname.split('/').at(-1)!;
        const content = blobs.get(sha);
        if (content === undefined) return json({ message: 'not found' }, 404);
        return json({ sha, encoding: 'base64', size: 1, content: btoa(content) });
      }
      return json({ message: 'unexpected route' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const read = async (next: typeof changes) => {
      await setChanges(next);
      const paths = next.map(change => change.path);
      const plan: PinnedPlan = {
        ...input.plan,
        changedFiles: next,
        changedPaths: paths,
        checkedChangedPaths: paths,
        selectedUpstreamPaths: paths,
        checkedSelectedUpstreamPaths: paths,
      };
      return client.readSourceSnapshot({
        plan,
        paths,
        maxFiles: 200,
        maxFileBytes: 100,
        maxBytes: 250_000,
        maxJobSeconds: 10,
      });
    };

    const modified = Array.from({ length: 140 }, (_, index) => ({
      path: `src/modified-${String(index).padStart(3, '0')}.ts`, status: 'modified' as const,
    }));
    const large = await read(modified);
    expect(large.beforeFiles).toHaveLength(140);
    expect(large.files).toHaveLength(140);
    expect(large.beforeFiles[0]?.content).toBe('o');
    expect(large.files[139]?.content).toBe('n');
    expect(calls.length).toBeGreaterThan(270);
    expect(calls.length).toBeLessThanOrEqual(350);

    calls.length = 0;
    const overAbsoluteLimit = Array.from({ length: 966 }, (_, index) => ({
      path: `src/large-${String(index).padStart(3, '0')}.ts`, status: 'modified' as const,
    }));
    const overPlan: PinnedPlan = {
      ...input.plan,
      changedFiles: overAbsoluteLimit,
      changedPaths: overAbsoluteLimit.map(file => file.path),
      checkedChangedPaths: overAbsoluteLimit.map(file => file.path),
      selectedUpstreamPaths: overAbsoluteLimit.map(file => file.path),
      checkedSelectedUpstreamPaths: overAbsoluteLimit.map(file => file.path),
    };
    await expect(client.readSourceSnapshot({
      plan: overPlan,
      paths: overAbsoluteLimit.map(file => file.path),
      maxFiles: 1_000,
      maxFileBytes: 100,
      maxBytes: 250_000,
      maxJobSeconds: 10,
    })).rejects.toMatchObject({ code: 'source-snapshot-request-limit' });
    expect(calls).toEqual([]);

    calls.length = 0;
    const mixed = await read([
      { path: 'src/added.ts', status: 'added' },
      { path: 'src/modified.ts', status: 'modified' },
      { path: 'src/deleted.ts', status: 'deleted' },
    ]);
    expect(mixed.beforeFiles.map(file => file.path).sort()).toEqual(['src/deleted.ts', 'src/modified.ts']);
    expect(mixed.files.map(file => file.path).sort()).toEqual(['src/added.ts', 'src/modified.ts']);
    expect(mixed.deletedPaths).toEqual(['src/deleted.ts']);
  });

  it('scopes private same-installation upstream reads by repository ID, including equal basenames', async () => {
    const upstream = { owner: 'upstream-org', name: 'target', fullName: 'upstream-org/target' };
    const observedScopes: number[][] = [];
    let sourceContentAuthorization: string | null = null;
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (Array.isArray(body.repository_ids)) observedScopes.push(body.repository_ids as number[]);
        return json(tokenResponseForBody(body));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName, upstream.fullName]));
      if (url.pathname === `/repos/${target.fullName}`) return json({ full_name: target.fullName, private: true, permissions: { push: true } });
      if (url.pathname === `/repos/${upstream.fullName}`) return json({ full_name: upstream.fullName, private: true, permissions: { pull: true } });
      if (url.pathname === `/repos/${upstream.fullName}/commits/${fromCommit}`) {
        return json({ sha: fromCommit, commit: { tree: { sha: '4'.repeat(40) }, message: 'previous private source' }, parents: [] });
      }
      if (url.pathname === `/repos/${upstream.fullName}/commits/${upstreamCommit}`) {
        return json({ sha: upstreamCommit, commit: { tree: { sha: '5'.repeat(40) }, message: 'private upstream' }, parents: [] });
      }
      if (url.pathname === `/repos/${upstream.fullName}/git/trees/${'4'.repeat(40)}`) {
        return json({ sha: '4'.repeat(40), truncated: false, tree: [{ path: 'src/parser.ts', mode: '100644', type: 'blob', sha: '7'.repeat(40), size: 6 }] });
      }
      if (url.pathname === `/repos/${upstream.fullName}/git/trees/${'5'.repeat(40)}`) {
        return json({ sha: '5'.repeat(40), truncated: false, tree: [{ path: 'src/parser.ts', mode: '100644', type: 'blob', sha: '8'.repeat(40), size: 6 }] });
      }
      if (url.pathname === `/repos/${upstream.fullName}/git/blobs/${'7'.repeat(40)}`) {
        sourceContentAuthorization = new Headers(init?.headers).get('Authorization');
        return json({ sha: '7'.repeat(40), encoding: 'base64', size: 6, content: btoa('prior!') });
      }
      if (url.pathname === `/repos/${upstream.fullName}/git/blobs/${'8'.repeat(40)}`) {
        sourceContentAuthorization = new Headers(init?.headers).get('Authorization');
        return json({ sha: '8'.repeat(40), encoding: 'base64', size: 6, content: btoa('parser') });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const result = await client.verifyTrackingAccess({
      installationId: 23,
      target,
      upstreamRepository: 'https://github.com/upstream-org/target.git',
    });
    expect(result).toEqual({ targetAccessible: true, targetWritable: true, upstreamReadable: true });
    expect(observedScopes).toContainEqual([101]);
    expect(observedScopes).toContainEqual([303]);
    const source = await client.readSourceSnapshot({
      plan: {
        trackingId: 'tracking_equal_name',
        installationId: 23,
        target,
        baseBranch: 'main',
        targetBaseCommit,
        upstreamRepository: 'https://github.com/upstream-org/target.git',
        upstreamRef: 'main',
        fromCommit,
        expectedLastCheckedCommit: fromCommit,
        toCommit: upstreamCommit,
        commitCount: 1,
        changedFiles: [{ path: 'src/parser.ts', status: 'modified' }],
        changedPaths: ['src/parser.ts'],
        checkedChangedPaths: ['src/parser.ts'],
        observedAt: new Date(timestampMs).toISOString(),
        jobId,
        jobKey: jobId,
        policyHash: 'a'.repeat(64),
        selectedUpstreamPaths: ['src/parser.ts'],
        checkedSelectedUpstreamPaths: ['src/parser.ts'],
        selectedSelectionIds: ['parser'],
      },
      paths: ['src/parser.ts'],
      maxFiles: 5,
      maxFileBytes: 1_000,
      maxBytes: 1_000,
      maxJobSeconds: 10,
    });
    expect(source.files[0]?.content).toBe('parser');
    expect(sourceContentAuthorization).toBe('Bearer ghs-test-installation-token');
  });

  it('paginates bounded compare commits and pins the exact branch tip', async () => {
    const policy = parsePolicy(policyInput({ maxCommits: 200, maxChangedPaths: 500 }));
    const digest = await policyHash(policy);
    const registration = makeRegistration(policy, digest);
    const commits = Array.from({ length: 101 }, (_, index) => ({ sha: index === 100 ? upstreamCommit : (index + 1).toString(16).padStart(40, '0') }));
    const calls: string[] = [];
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname === '/app/installations/23/access_tokens') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(tokenResponseForBody(body));
      }
      if (url.pathname === '/installation/repositories') {
        return json(installationRepositoryInventory([target.fullName, 'upstream-org/project']));
      }
      if (url.pathname === '/repos/upstream-org/project') return json({ full_name: 'upstream-org/project', private: true });
      if (url.pathname === '/repos/upstream-org/project/commits/main') {
        return json({ sha: upstreamCommit, commit: { tree: { sha: '3'.repeat(40) }, message: 'tip' }, parents: [] });
      }
      if (url.pathname.startsWith('/repos/upstream-org/project/compare/')) {
        const page = Number(url.searchParams.get('page'));
        return json({
          status: 'ahead',
          total_commits: 101,
          ahead_by: 101,
          behind_by: 0,
          base_commit: { sha: fromCommit },
          merge_base_commit: { sha: fromCommit },
          commits: page === 1 ? commits.slice(0, 100) : commits.slice(100),
          files: page === 1 ? [{ filename: 'src/parser.ts', status: 'modified' }] : [],
        });
      }
      if (url.pathname === '/repos/target-org/target/branches/main') {
        return json({ name: 'main', commit: { sha: targetBaseCommit } });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const plan = await client.discoverPlan(registration, policy);
    expect(plan?.toCommit).toBe(upstreamCommit);
    expect(plan?.commitCount).toBe(101);
    expect(plan?.changedPaths).toEqual(['src/parser.ts']);
    expect(calls.some(path => path.includes('page=2'))).toBe(true);
    expect(calls.filter(path => path.includes('/commits/main')).length).toBe(2);
  });

  it('fails closed when compare files reach GitHub’s truncation ceiling or history is force-pushed', async () => {
    const policy = parsePolicy(policyInput({ maxChangedPaths: 5_000 }));
    const digest = await policyHash(policy);
    const registration = makeRegistration(policy, digest);
    const compareResponse = (status: string, mergeBase: string, files: unknown[]) => ({
      status,
      total_commits: 1,
      ahead_by: 1,
      behind_by: status === 'diverged' ? 1 : 0,
      base_commit: { sha: fromCommit },
      merge_base_commit: { sha: mergeBase },
      commits: [{ sha: upstreamCommit }],
      files,
    });
    let result = compareResponse('ahead', fromCommit, Array.from({ length: 300 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: 'modified' })));
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(tokenResponseForBody(body));
      }
      if (url.pathname === '/installation/repositories') {
        return json(installationRepositoryInventory([target.fullName, 'upstream-org/project']));
      }
      if (url.pathname === '/repos/upstream-org/project') return json({ full_name: 'upstream-org/project', private: true });
      if (url.pathname === '/repos/upstream-org/project/commits/main') return json({ sha: upstreamCommit, commit: { tree: { sha: '4'.repeat(40) }, message: 'tip' }, parents: [] });
      if (url.pathname.startsWith('/repos/upstream-org/project/compare/')) return json(result);
      if (url.pathname === '/repos/target-org/target/branches/main') return json({ name: 'main', commit: { sha: targetBaseCommit } });
      return json({}, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    await expect(client.discoverPlan(registration, policy)).rejects.toMatchObject({ code: 'compare-files-truncated' });
    result = compareResponse('diverged', '9'.repeat(40), [{ filename: 'src/parser.ts', status: 'modified' }]);
    await expect(client.discoverPlan(registration, policy)).rejects.toMatchObject({ code: 'upstream-history-ambiguous' });
    result = compareResponse('ahead', fromCommit, [{
      filename: 'src/new-parser.ts', previous_filename: 'src/parser.ts', status: 'renamed',
    }]);
    const renamed = await client.discoverPlan(registration, policy);
    expect(renamed?.changedFiles).toEqual([
      { path: 'src/parser.ts', status: 'deleted' },
      { path: 'src/new-parser.ts', status: 'added' },
    ]);
    expect(renamed?.changedPaths).toEqual(['src/parser.ts', 'src/new-parser.ts']);
  });

  it('materializes a complete bounded target test workspace through GitHub while omitting sensitive and instruction files', async () => {
    const contents = new Map<string, string>();
    const safePaths = ['package.json', 'test/parser.test.ts', 'lib/parser.ts', 'README-bom.md', 'empty-executable.ts'];
    const excludedPaths = ['AGENTS.md', '.env', '.github/workflows/ci.yml', '.opencode/config.json'];
    const allPaths = [...safePaths, ...excludedPaths];
    const entries = allPaths.map((path, index) => {
      const sha = String(index + 5).repeat(40).slice(0, 40);
      const content = path === 'README-bom.md' ? '\uFEFFread me' : path === 'empty-executable.ts' ? '' : `content for ${path}`;
      contents.set(sha, content);
      return { path, mode: path === 'empty-executable.ts' ? '100755' : '100644', type: 'blob', sha, size: new TextEncoder().encode(content).length };
    });
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(tokenResponseForBody(body));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === `/repos/${target.fullName}/commits/${targetBaseCommit}`) {
        return json({ sha: targetBaseCommit, commit: { tree: { sha: baseTreeSha }, message: 'target base' }, parents: [] });
      }
      if (url.pathname === `/repos/${target.fullName}/git/trees/${baseTreeSha}`) return json({ sha: baseTreeSha, truncated: false, tree: entries });
      if (url.pathname.startsWith(`/repos/${target.fullName}/git/blobs/`)) {
        const sha = url.pathname.split('/').at(-1)!;
        const content = contents.get(sha)!;
        const bytes = new TextEncoder().encode(content);
        return json({ sha, encoding: 'base64', size: bytes.length, content: btoa(String.fromCharCode(...bytes)) });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    const workspace = await client.readTargetWorkspace({
      installationId: 23,
      target,
      commit: targetBaseCommit,
      excludedPathPatterns: [],
      maxFiles: 20,
      maxFileBytes: 10_000,
      maxBytes: 10_000,
      maxDirectories: 10_000,
      maxPathBytes: 1_024,
      maxPathDepth: 64,
      maxJobSeconds: 30,
    });
    expect(workspace.commit).toBe(targetBaseCommit);
    expect(workspace.files.map(file => file.path).sort()).toEqual([...safePaths].sort());
    expect(workspace.files.map(file => file.content)).toEqual([
      'content for package.json',
      'content for test/parser.test.ts',
      'content for lib/parser.ts',
      '\uFEFFread me',
      '',
    ]);
    expect(workspace.files.find(file => file.path === 'README-bom.md')?.sizeBytes).toBe(new TextEncoder().encode('\uFEFFread me').length);
    expect(workspace.files.find(file => file.path === 'empty-executable.ts')?.mode).toBe('100755');

    const verified = await client.readVerificationWorkspace({
      plan: (await makeProposal(await policyHash(parsePolicy(policyInput())))).plan,
      excludedPathPatterns: [],
      limits: DEFAULT_VERIFICATION_WORKSPACE_LIMITS,
      maxJobSeconds: 30,
    });
    expect(verified.complete).toBe(true);
    expect(verified.baseBranch).toBe('main');
    expect([...verified.existingPaths].sort()).toEqual([...safePaths].sort());
  });

  it('shares glob work across a complete tree scan and applies the operation deadline before empty materialization', async () => {
    const entries = Array.from({ length: 1_800 }, (_, index) => ({
      path: `.config/gcloud/key-${index}.json`,
      mode: '100644',
      type: 'blob',
      sha: '5'.repeat(40),
      size: 1,
    }));
    let globBlobReads = 0;
    const globFetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens') {
        return json(tokenResponseForBody(JSON.parse(String(init?.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === `/repos/${target.fullName}/commits/${targetBaseCommit}`) {
        return json({ sha: targetBaseCommit, commit: { tree: { sha: baseTreeSha }, message: 'base' }, parents: [] });
      }
      if (url.pathname === `/repos/${target.fullName}/git/trees/${baseTreeSha}`) return json({ sha: baseTreeSha, truncated: false, tree: entries });
      if (url.pathname.includes('/git/blobs/')) globBlobReads++;
      return json({ message: 'not found' }, 404);
    };
    const globClient = new GitHubAppClient(apiCredentials(), { fetch: globFetcher, now: () => timestampMs });
    await expect(globClient.readTargetWorkspace({
      installationId: 23,
      target,
      commit: targetBaseCommit,
      excludedPathPatterns: [],
      maxFiles: 1,
      maxFileBytes: 1_000,
      maxBytes: 1_000,
      maxDirectories: 10_000,
      maxPathBytes: 1_024,
      maxPathDepth: 64,
      maxJobSeconds: 10,
    })).rejects.toThrow('Glob matching work exceeds the deterministic safety limit');
    expect(globBlobReads).toBe(0);

    let blobReads = 0;
    const slowFetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens') {
        return json(tokenResponseForBody(JSON.parse(String(init?.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === `/repos/${target.fullName}/commits/${targetBaseCommit}`) {
        return json({ sha: targetBaseCommit, commit: { tree: { sha: baseTreeSha }, message: 'base' }, parents: [] });
      }
      if (url.pathname === `/repos/${target.fullName}/git/trees/${baseTreeSha}`) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return json({ sha: baseTreeSha, truncated: false, tree: [] });
      }
      if (url.pathname.includes('/git/blobs/')) blobReads++;
      return json({ message: 'not found' }, 404);
    };
    const slowClient = new GitHubAppClient(apiCredentials(), { fetch: slowFetcher, now: () => timestampMs });
    await expect(slowClient.readTargetWorkspace({
      installationId: 23,
      target,
      commit: targetBaseCommit,
      excludedPathPatterns: [],
      maxFiles: 10,
      maxFileBytes: 1_000,
      maxBytes: 1_000,
      maxDirectories: 10_000,
      maxPathBytes: 1_024,
      maxPathDepth: 64,
      maxJobSeconds: 0.02,
    })).rejects.toMatchObject({ code: 'github-operation-time-limit' });
    expect(blobReads).toBe(0);
  });

  it('starts discovery time accounting before ref resolution and never compares after the deadline', async () => {
    const raw = policyInput({ maxJobSeconds: 1 });
    const policy = parsePolicy(raw);
    const digest = await policyHash(policy);
    const registration = makeRegistration(policy, digest);
    const calls: string[] = [];
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(url.pathname);
      if (url.pathname === '/app/installations/23/access_tokens') {
        return json(tokenResponseForBody(JSON.parse(String(init?.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === '/repos/upstream-org/project') return json({ full_name: 'upstream-org/project', private: false });
      if (url.pathname === '/repos/upstream-org/project/commits/main') {
        await new Promise(resolve => setTimeout(resolve, 1_100));
        return json({ sha: upstreamCommit, commit: { tree: { sha: '4'.repeat(40) }, message: 'tip' }, parents: [] });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    await expect(client.discoverPlan(registration, policy)).rejects.toMatchObject({ code: 'github-operation-time-limit' });
    expect(calls.some(path => path.includes('/compare/'))).toBe(false);
    expect(calls.some(path => path.endsWith('/branches/main'))).toBe(false);
  });

  it('keeps fatal UTF-8 decoding for malformed regular Git blobs', async () => {
    const fetcher: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/app/installations/23/access_tokens') {
        return json(tokenResponseForBody(JSON.parse(String(init?.body)) as Record<string, unknown>));
      }
      if (url.pathname === '/installation/repositories') return json(installationRepositoryInventory([target.fullName]));
      if (url.pathname === `/repos/${target.fullName}/commits/${targetBaseCommit}`) {
        return json({ sha: targetBaseCommit, commit: { tree: { sha: baseTreeSha }, message: 'base' }, parents: [] });
      }
      if (url.pathname === `/repos/${target.fullName}/git/trees/${baseTreeSha}`) {
        return json({ sha: baseTreeSha, truncated: false, tree: [{ path: 'lib/parser.ts', mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 1 }] });
      }
      if (url.pathname === `/repos/${target.fullName}/git/blobs/${'a'.repeat(40)}`) {
        return json({ sha: 'a'.repeat(40), encoding: 'base64', size: 1, content: btoa(String.fromCharCode(0xff)) });
      }
      return json({ message: 'not found' }, 404);
    };
    const client = new GitHubAppClient(apiCredentials(), { fetch: fetcher, now: () => timestampMs });
    await expect(client.readTargetWorkspace({
      installationId: 23,
      target,
      commit: targetBaseCommit,
      excludedPathPatterns: [],
      maxFiles: 5,
      maxFileBytes: 1_000,
      maxBytes: 1_000,
      maxDirectories: 10_000,
      maxPathBytes: 1_024,
      maxPathDepth: 64,
      maxJobSeconds: 10,
    })).rejects.toMatchObject({ code: 'github-binary-file-rejected' });
  });

  it('rejects stale target bases before creating publication effects', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const api = new PublisherGitHubApi();
    api.baseSha = '9'.repeat(40);
    const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
    await expect(client.publishDraft(input)).rejects.toMatchObject({ code: 'stale-target-base' });
    expect(api.calls.some(call => call.method === 'POST' && call.path.includes('/git/'))).toBe(false);
    expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false);
  });

  it('recovers an ambiguous branch-ref timeout and a PR-create timeout without duplicate branches or PRs', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const api = new PublisherGitHubApi();
    api.failAfterRefCreate = true;
    api.timeoutAfterPullCreate = true;
    const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
    const publication = await client.publishDraft(input);
    expect(publication).toEqual({ pullRequestNumber: 17, url: `https://github.com/${target.fullName}/pull/17`, headCommit: 'e'.repeat(40) });
    expect(api.calls.filter(call => call.method === 'POST' && call.path === `/repos/${target.fullName}/git/refs`)).toHaveLength(1);
    expect(api.calls.filter(call => call.method === 'POST' && call.path === `/repos/${target.fullName}/pulls`)).toHaveLength(1);
    const recovered = await client.publishDraft(input);
    expect(recovered).toEqual(publication);
    expect(api.calls.filter(call => call.method === 'POST' && call.path === `/repos/${target.fullName}/pulls`)).toHaveLength(1);
  });

  it('round-trips BOM-prefixed and empty text blobs through verified publication', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    for (const content of ['\uFEFFexport const parser = true;', '']) {
      const input = await makeProposal(digest, content);
      const api = new PublisherGitHubApi();
      const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
      const publication = await client.publishDraft(input);
      expect(publication.pullRequestNumber).toBe(17);
      expect(api.blobContent).toBe(content);
    }
  });

  it('never moves or adopts an unrelated branch with the deterministic job name', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const api = new PublisherGitHubApi();
    api.branchSha = '7'.repeat(40);
    api.existingBranchCommit = { sha: api.branchSha, tree: baseTreeSha, message: 'human branch', parents: [targetBaseCommit] };
    const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
    await expect(client.publishDraft(input)).rejects.toMatchObject({ code: 'publication-branch-owned-by-other-job' });
    expect(api.calls.some(call => call.method === 'PATCH' || call.method === 'PUT')).toBe(false);
    expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/git/refs'))).toBe(false);
  });

  it('blocks another tracked draft or ready-for-review PR before any ref or PR side effect', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    for (const draft of [true, false]) {
      const api = new PublisherGitHubApi();
      api.prs.push(api.pullRequest(31, '7'.repeat(40), draft, false, `oc-port-agent-${'a'.repeat(64)}`));
      const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
      await expect(client.publishDraft(input)).rejects.toMatchObject({ code: 'other-tracked-pull-request-open' });
      expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/git/refs'))).toBe(false);
      expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false);
    }
  });

  it('does not block unrelated human PRs but fails closed on tracked-PR pagination truncation', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const humanPr = (number: number): Record<string, unknown> => ({
      number,
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      html_url: `https://github.com/${target.fullName}/pull/${number}`,
      base: { ref: 'main', sha: targetBaseCommit, repo: { full_name: target.fullName } },
      head: { ref: `human-${number}`, sha: '7'.repeat(40), repo: { full_name: 'contributor/fork' } },
    });
    const humanApi = new PublisherGitHubApi();
    humanApi.openPullsOverride = Array.from({ length: 100 }, (_, index) => humanPr(index + 1));
    const humanClient = new GitHubAppClient(apiCredentials(), { fetch: humanApi.fetch.bind(humanApi), now: () => timestampMs });
    await expect(humanClient.publishDraft(input)).resolves.toMatchObject({ pullRequestNumber: 17 });

    const truncatedApi = new PublisherGitHubApi();
    truncatedApi.openPullsOverride = Array.from({ length: 1_000 }, (_, index) => humanPr(index + 1));
    const truncatedClient = new GitHubAppClient(apiCredentials(), { fetch: truncatedApi.fetch.bind(truncatedApi), now: () => timestampMs });
    await expect(truncatedClient.publishDraft(input)).rejects.toMatchObject({ code: 'open-pull-request-list-truncated' });
    expect(truncatedApi.calls.some(call => call.method === 'POST' && call.path.endsWith('/git/refs'))).toBe(false);
    expect(truncatedApi.calls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false);
  });

  it('rechecks tracked target drafts after creating a branch and refuses a second PR if one appears', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const api = new PublisherGitHubApi();
    api.injectTrackedPrOnSecondOpenList = true;
    const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
    await expect(client.publishDraft(input)).rejects.toMatchObject({ code: 'other-tracked-pull-request-open' });
    expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/git/refs'))).toBe(true);
    expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false);
  });

  it('shares the REST request ceiling across repeated branch recovery scans', async () => {
    const rawPolicyForLargeProposal = policyInput({ maxFiles: 1_000 });
    const selections = rawPolicyForLargeProposal.selections as Array<Record<string, unknown>>;
    selections[0]!.targetPaths = ['**'];
    const policy = parsePolicy(rawPolicyForLargeProposal);
    const digest = await policyHash(policy);
    const input = await makeProposal(digest, 'x');
    input.registration.policy = policy;
    const paths = Array.from({ length: 1_000 }, (_, index) => `file${index}.txt`);
    const contentDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x')));
    const sha256 = [...contentDigest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    input.proposal = {
      ...input.proposal,
      edits: paths.map(path => ({ path, operation: 'write' as const, content: 'x' })),
      verification: {
        status: 'passed',
        steps: [{ index: 0, exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 }],
        workspaceFiles: paths.map(path => ({ path, operation: 'write' as const, sha256, mode: '100644' as const })),
      },
    };
    const api = new PublisherGitHubApi();
    api.branchSha = 'e'.repeat(40);
    api.branchTreeSha = '2'.repeat(40);
    api.branchParents = [targetBaseCommit];
    api.branchCommitMessage = [
      'chore: recovered job',
      '',
      `oc-port-agent-job: ${jobId}`,
      `oc-port-agent-upstream: ${upstreamCommit}`,
      `oc-port-agent-policy: ${digest}`,
      `oc-port-agent-target-base: ${targetBaseCommit}`,
    ].join('\n');
    api.branchTree = paths.map(path => ({ path, mode: '100644', type: 'blob', sha: '9'.repeat(40), size: 1 }));
    api.blobContent = 'x';
    const client = new GitHubAppClient(apiCredentials(), { fetch: api.fetch.bind(api), now: () => timestampMs });
    await expect(client.publishDraft(input)).rejects.toMatchObject({ code: 'github-operation-request-limit' });
    expect(api.calls).toHaveLength(2_000);
    expect(api.calls.some(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toBe(false);
  });

  it('requires durable proposal evidence and rechecks the merged branch tree before checkpoint activation', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const noEvidence = new GitHubAppClient(apiCredentials(), { fetch: async () => json({}), now: () => timestampMs });
    expect(await noEvidence.confirmMergedCheckpoint({ registration: input.registration, candidate: input.proposal.checkpointCandidate })).toBeUndefined();

    const api = new PublisherGitHubApi();
    const client = new GitHubAppClient(apiCredentials(), {
      fetch: api.fetch.bind(api),
      now: () => timestampMs,
      loadCheckpointEvidence: async candidate => candidate.jobKey === input.plan.jobKey
        ? { plan: input.plan, proposal: input.proposal }
        : undefined,
    });
    const publication = await client.publishDraft(input);
    api.baseSha = '8'.repeat(40);
    api.prs[0] = api.pullRequest(publication.pullRequestNumber, publication.headCommit, false, true);
    const observation = await client.confirmMergedCheckpoint({
      registration: input.registration,
      candidate: input.proposal.checkpointCandidate,
    });
    expect(observation).toMatchObject({
      trackingId: input.registration.id,
      jobId,
      pullRequestNumber: publication.pullRequestNumber,
      baseBranch: 'main',
      upstreamCommit,
      targetBaseCommit,
      observedBaseCommit: '8'.repeat(40),
      mergeCommit: '8'.repeat(40),
    });
  });

  it('reports durable pull-request lifecycle by number without conflating open, closed, merged, or unknown', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    const api = new PublisherGitHubApi();
    const client = new GitHubAppClient(apiCredentials(), {
      fetch: api.fetch.bind(api),
      now: () => timestampMs,
      loadCheckpointEvidence: async candidate => candidate.jobKey === input.plan.jobKey
        ? { plan: input.plan, proposal: input.proposal }
        : undefined,
    });
    const publication = await client.publishDraft(input);
    const lifecycleInput = {
      registration: input.registration,
      candidate: input.proposal.checkpointCandidate,
      pullRequestNumber: publication.pullRequestNumber,
    };
    await expect(client.getPullRequestLifecycle(lifecycleInput)).resolves.toMatchObject({
      status: 'open', pullRequestNumber: publication.pullRequestNumber,
    });
    await expect(client.getPullRequestLifecycle({ ...lifecycleInput, pullRequestNumber: 999 }))
      .resolves.toEqual({ status: 'unknown' });

    api.prs[0] = { ...api.prs[0]!, state: 'closed', draft: false, merged: false, merged_at: null, merge_commit_sha: null };
    await expect(client.getPullRequestLifecycle(lifecycleInput)).resolves.toMatchObject({
      status: 'closed-unmerged', pullRequestNumber: publication.pullRequestNumber,
    });

    api.baseSha = '8'.repeat(40);
    api.prs[0] = api.pullRequest(publication.pullRequestNumber, publication.headCommit, false, true);
    const merged = await client.getPullRequestLifecycle(lifecycleInput);
    expect(merged).toMatchObject({
      status: 'merged',
      observation: {
        pullRequestNumber: publication.pullRequestNumber,
        upstreamCommit,
        targetBaseCommit,
        observedBaseCommit: '8'.repeat(40),
      },
    });
  });

  it('rejects discarded merge edits, merged mode drift, and a later configured-base revert', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const makeMerged = async () => {
      const input = await makeProposal(digest);
      const api = new PublisherGitHubApi();
      const client = new GitHubAppClient(apiCredentials(), {
        fetch: api.fetch.bind(api),
        now: () => timestampMs,
        loadCheckpointEvidence: async () => ({ plan: input.plan, proposal: input.proposal }),
      });
      const publication = await client.publishDraft(input);
      api.baseSha = '8'.repeat(40);
      api.prs[0] = api.pullRequest(publication.pullRequestNumber, publication.headCommit, false, true);
      return { api, client, input };
    };

    const discarded = await makeMerged();
    discarded.api.mergedTreeOverride = [];
    await expect(discarded.client.confirmMergedCheckpoint({
      registration: discarded.input.registration,
      candidate: discarded.input.proposal.checkpointCandidate,
    })).rejects.toMatchObject({ code: 'merged-tree-diff-mismatch' });

    const modeDrift = await makeMerged();
    modeDrift.api.mergedTreeOverride = modeDrift.api.branchTree.map(entry => ({ ...entry, mode: '100755' }));
    await expect(modeDrift.client.confirmMergedCheckpoint({
      registration: modeDrift.input.registration,
      candidate: modeDrift.input.proposal.checkpointCandidate,
    })).rejects.toMatchObject({ code: 'merged-tree-mode-mismatch' });

    const laterRevert = await makeMerged();
    laterRevert.api.baseSha = '9'.repeat(40);
    await expect(laterRevert.client.confirmMergedCheckpoint({
      registration: laterRevert.input.registration,
      candidate: laterRevert.input.proposal.checkpointCandidate,
    })).rejects.toMatchObject({ code: 'configured-base-write-not-retained' });
  });

  it('proves a staged deletion in the actual merge result and accepts the supported single-parent strategy', async () => {
    const policy = parsePolicy(policyInput());
    const digest = await policyHash(policy);
    const input = await makeProposal(digest);
    input.proposal = {
      ...input.proposal,
      report: { summary: 'Remove obsolete parser file', decisions: [{ selection: 'parser', status: 'applied', reason: 'The old file was removed.' }] },
      edits: [{ path: 'lib/parser.ts', operation: 'delete' }],
      verification: {
        status: 'passed',
        steps: [{ index: 0, exitCode: 0, durationMs: 100, stdoutBytes: 0, stderrBytes: 0 }],
        workspaceFiles: [{ path: 'lib/parser.ts', operation: 'delete' }],
      },
    };
    const api = new PublisherGitHubApi();
    api.baseTree = [{ path: 'lib/parser.ts', mode: '100644', type: 'blob', sha: '4'.repeat(40), size: 8 }];
    api.mergeParentsOverride = [targetBaseCommit];
    const client = new GitHubAppClient(apiCredentials(), {
      fetch: api.fetch.bind(api),
      now: () => timestampMs,
      loadCheckpointEvidence: async () => ({ plan: input.plan, proposal: input.proposal }),
    });
    const publication = await client.publishDraft(input);
    api.baseSha = '8'.repeat(40);
    api.prs[0] = api.pullRequest(publication.pullRequestNumber, publication.headCommit, false, true);
    const observation = await client.confirmMergedCheckpoint({
      registration: input.registration,
      candidate: input.proposal.checkpointCandidate,
    });
    expect(observation?.mergeCommit).toBe('8'.repeat(40));
    expect(api.calls.some(call => call.method === 'GET' && call.path.endsWith(`/git/blobs/${'4'.repeat(40)}`))).toBe(false);
  });

  it('verifies HMAC signatures over the exact raw webhook bytes', async () => {
    const body = new TextEncoder().encode('{"x":1}');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('webhook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
    const signature = `sha256=${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    expect(await verifyGitHubWebhookSignature(body, signature, 'webhook-secret')).toBe(true);
    expect(await verifyGitHubWebhookSignature(new TextEncoder().encode('{"x":1 }'), signature, 'webhook-secret')).toBe(false);
    expect(await verifyGitHubWebhookSignature(body, 'sha256=invalid', 'webhook-secret')).toBe(false);
  });
});
