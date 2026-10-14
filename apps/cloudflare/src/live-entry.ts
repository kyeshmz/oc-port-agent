import type { ExecutionContextBinding, Env, QueueBatchBinding, ScheduledEventBinding } from './env.js';
import type {
  RunnerRequest,
  VerificationResult,
  VerificationWorkspaceSnapshot,
} from './contracts.js';
import { DEFAULT_VERIFICATION_WORKSPACE_LIMITS } from './contracts.js';
import { GitHubAppClient, type TargetWorkspaceGitHubPort, type TargetWorkspaceSnapshot } from './github.js';
import { createSandboxRunner, type SandboxNamespace, type VerificationOutputObservation } from './sandbox.js';
import defaultWorker, { Sandbox, TargetJobDO } from './index.js';

export { Sandbox, TargetJobDO };

const FIXTURE = Object.freeze({
  owner: 'kyeshmz',
  name: 'oc-port-agent-live-test-20261010',
  fullName: 'kyeshmz/oc-port-agent-live-test-20261010',
  installationId: 170044765,
  baseBranch: 'main',
  baseCommit: '8cf62db4e306d8b40cdf7cb4a7b016333ded6655',
  upstreamCommit: '1bb823ad50fb85613fbde65712418a1ecf0a00d4',
  jobId: 'live-runtime-check',
  trackingId: 'live-runtime-check',
  jobKey: `job_${'e'.repeat(64)}`,
  policyHash: '0'.repeat(64),
  targetPaths: ['lib/strip-prefix.js', 'lib/target-helpers.js'],
  verification: [{ command: 'node', args: ['--test', 'test/strip-prefix.test.mjs'], timeoutSeconds: 30 }],
  excludedPathPatterns: [],
});

const MAX_READ_SECONDS = 30;
const MAX_RUN_SECONDS = 120;
const MAX_OUTPUT_BYTES = 16_384;
const REQUEST_BODY_TIMEOUT_MS = 500;
const CLEANUP_TIMEOUT_MS = 5_000;
const EXPECTED_TEST_NAMES = Object.freeze([
  'remove exactly one leading BOM, preserving repeated and interior BOMs',
  'reject nonstrings without coercion',
  'preserve the target-only helper',
] as const);
const BOM = '\uFEFF';

type RuntimeRunner = ReturnType<typeof createSandboxRunner>;
type LiveWorker = {
  fetch(request: Request, env: Env, context: ExecutionContextBinding): Promise<Response>;
  scheduled(event: ScheduledEventBinding, env: Env, context: ExecutionContextBinding): void;
  queue(batch: QueueBatchBinding, env: Env, context: ExecutionContextBinding): Promise<void>;
};

export interface LiveEntryDependencies {
  baseWorker?: LiveWorker;
  githubFor?: (env: Env) => Pick<TargetWorkspaceGitHubPort, 'readTargetWorkspace'>;
  runnerFor?: (
    namespace: SandboxNamespace,
    observer: (observation: VerificationOutputObservation) => void,
  ) => Pick<RuntimeRunner, 'verify' | 'cancel'>;
  readWorkspace?: (github: Pick<TargetWorkspaceGitHubPort, 'readTargetWorkspace'>) => Promise<TargetWorkspaceSnapshot>;
  runtimeTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export class LiveRuntimeCheckError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LiveRuntimeCheckError';
    this.code = code;
  }
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

async function requireEmptyBody(request: Request): Promise<void> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new LiveRuntimeCheckError('runtime-check-body-not-empty');
  }
  if (!request.body) return;

  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LiveRuntimeCheckError('runtime-check-body-timeout')), REQUEST_BODY_TIMEOUT_MS);
      }),
    ]);
    if (!result.done && result.value.byteLength > 0) throw new LiveRuntimeCheckError('runtime-check-body-not-empty');
    if (!result.done) throw new LiveRuntimeCheckError('runtime-check-body-not-empty');
  } catch (error) {
    if (error instanceof LiveRuntimeCheckError) throw error;
    throw new LiveRuntimeCheckError('runtime-check-body-invalid');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LiveRuntimeCheckError(code)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makePlan() {
  return {
    trackingId: FIXTURE.trackingId,
    installationId: FIXTURE.installationId,
    target: { owner: FIXTURE.owner, name: FIXTURE.name, fullName: FIXTURE.fullName },
    baseBranch: FIXTURE.baseBranch,
    targetBaseCommit: FIXTURE.baseCommit,
    upstreamRepository: `https://github.com/${FIXTURE.fullName}.git`,
    upstreamRef: 'upstream',
    fromCommit: FIXTURE.baseCommit,
    expectedLastCheckedCommit: FIXTURE.baseCommit,
    toCommit: FIXTURE.upstreamCommit,
    commitCount: 1,
    changedFiles: [{ path: 'reference/bom.js', status: 'modified' as const }],
    changedPaths: ['reference/bom.js'],
    checkedChangedPaths: ['reference/bom.js'],
    observedAt: '2026-10-10T00:00:00.000Z',
    jobId: FIXTURE.jobId,
    jobKey: FIXTURE.jobKey,
    policyHash: FIXTURE.policyHash,
    selectedUpstreamPaths: ['reference/bom.js'],
    checkedSelectedUpstreamPaths: ['reference/bom.js'],
    selectedSelectionIds: ['strip-prefix-bom'],
  };
}

function validSnapshot(snapshot: TargetWorkspaceSnapshot): boolean {
  if (!snapshot || !snapshot.repository || !Array.isArray(snapshot.files)
    || typeof snapshot.repository.fullName !== 'string'
    || typeof snapshot.repository.owner !== 'string' || typeof snapshot.repository.name !== 'string'
    || typeof snapshot.commit !== 'string'
    || snapshot.repository.fullName.toLowerCase() !== FIXTURE.fullName.toLowerCase()
    || snapshot.repository.owner.toLowerCase() !== FIXTURE.owner.toLowerCase()
    || snapshot.repository.name.toLowerCase() !== FIXTURE.name.toLowerCase()
    || snapshot.commit.toLowerCase() !== FIXTURE.baseCommit.toLowerCase()
    || snapshot.files.length < 1 || snapshot.files.length > 128) return false;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || file.path.length < 1 || file.path.length > 1_024
      || file.path.startsWith('/') || file.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || seen.has(file.path) || (file.mode !== '100644' && file.mode !== '100755')
      || typeof file.content !== 'string' || file.content.includes('\0')) return false;
    const size = new TextEncoder().encode(file.content).byteLength;
    if (size !== file.sizeBytes || size > 500_000) return false;
    totalBytes += size;
    if (totalBytes > 2_000_000) return false;
    seen.add(file.path);
  }
  return FIXTURE.targetPaths.every(path => seen.has(path)) && seen.has('test/strip-prefix.test.mjs');
}

async function snapshotDigest(snapshot: TargetWorkspaceSnapshot): Promise<string> {
  const files = await Promise.all([...snapshot.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(async file => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.content));
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return { path: file.path, mode: file.mode, sizeBytes: file.sizeBytes, sha256 };
    }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(files)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function makeRunnerRequest(snapshot: TargetWorkspaceSnapshot): RunnerRequest {
  const plan = makePlan();
  const verificationWorkspace: VerificationWorkspaceSnapshot = {
    complete: true,
    repository: { ...snapshot.repository },
    baseBranch: FIXTURE.baseBranch,
    commit: FIXTURE.baseCommit,
    existingPaths: snapshot.files.map(file => file.path),
    files: snapshot.files.map(file => ({ ...file })),
  };
  const selected = new Set(FIXTURE.targetPaths);
  return {
    jobId: FIXTURE.jobId,
    plan,
    target: {
      repository: { ...snapshot.repository },
      baseBranch: FIXTURE.baseBranch,
      commit: FIXTURE.baseCommit,
      existingPaths: snapshot.files.filter(file => selected.has(file.path)).map(file => file.path),
      files: snapshot.files.filter(file => selected.has(file.path)).map(file => ({ ...file })),
    },
    verificationWorkspace,
    edits: [],
    verification: FIXTURE.verification,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    maxJobSeconds: MAX_RUN_SECONDS,
    remainingJobSeconds: MAX_RUN_SECONDS,
  };
}

interface FixedOracleProof {
  totalTests: 3;
  passed: 2;
  failed: 1;
  failedTest: typeof EXPECTED_TEST_NAMES[0];
  passedTests: readonly [typeof EXPECTED_TEST_NAMES[1], typeof EXPECTED_TEST_NAMES[2]];
  failureCategory: 'ERR_ASSERTION/strictEqual/BOM-mismatch';
  stdoutBytes: number;
  stderrBytes: number;
}

function fixedOracleProof(observation: VerificationOutputObservation): FixedOracleProof | undefined {
  if (observation.jobId !== FIXTURE.jobId
    || observation.targetFullName.toLowerCase() !== FIXTURE.fullName.toLowerCase()
    || observation.targetBaseCommit.toLowerCase() !== FIXTURE.baseCommit.toLowerCase()
    || observation.verificationCount !== 1 || observation.index !== 0
    || observation.command !== 'node'
    || observation.args.length !== 2 || observation.args[0] !== '--test'
    || observation.args[1] !== 'test/strip-prefix.test.mjs'
    || observation.exitCode !== 1 || observation.timedOut || observation.truncated
    || typeof observation.stdout !== 'string' || typeof observation.stderr !== 'string'
    || observation.stderr !== '') return undefined;

  const stdoutBytes = new TextEncoder().encode(observation.stdout).byteLength;
  const stderrBytes = new TextEncoder().encode(observation.stderr).byteLength;
  if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) return undefined;
  const text = observation.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map(line => line.trim());
  const subtestLines = lines.filter(line => line.startsWith('# Subtest: '));
  const statusLines = lines.filter(line => /^(?:not )?ok \d+ - /.test(line));
  const expectedSubtests = EXPECTED_TEST_NAMES.map(name => `# Subtest: ${name}`);
  const expectedStatuses = [
    `not ok 1 - ${EXPECTED_TEST_NAMES[0]}`,
    `ok 2 - ${EXPECTED_TEST_NAMES[1]}`,
    `ok 3 - ${EXPECTED_TEST_NAMES[2]}`,
  ] as const;
  if (lines[0] !== 'TAP version 13'
    || JSON.stringify(subtestLines) !== JSON.stringify(expectedSubtests)
    || JSON.stringify(statusLines) !== JSON.stringify(expectedStatuses)
    || !lines.includes('# tests 3') || !lines.includes('# pass 2') || !lines.includes('# fail 1')) return undefined;

  const failedAt = lines.indexOf(expectedStatuses[0]);
  const passedAt = lines.indexOf(expectedStatuses[1]);
  if (failedAt < 0 || passedAt <= failedAt) return undefined;
  const failure = lines.slice(failedAt, passedAt).join('\n');
  const hasBomMismatch = failure.includes(`'${BOM}plain' !== 'plain'`);
  if (!failure.includes("failureType: 'testCodeFailure'")
    || !failure.includes("code: 'ERR_ASSERTION'")
    || !failure.includes("name: 'AssertionError'")
    || !failure.includes("operator: 'strictEqual'") || !hasBomMismatch) {
    return undefined;
  }
  return {
    totalTests: 3,
    passed: 2,
    failed: 1,
    failedTest: EXPECTED_TEST_NAMES[0],
    passedTests: [EXPECTED_TEST_NAMES[1], EXPECTED_TEST_NAMES[2]],
    failureCategory: 'ERR_ASSERTION/strictEqual/BOM-mismatch',
    stdoutBytes,
    stderrBytes,
  };
}

function expectedFailureEvidence(
  result: VerificationResult,
  oracle: FixedOracleProof | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(result) || !Array.isArray(result.steps) || !Array.isArray(result.workspaceFiles)
    || result.status !== 'failed' || result.failureCode !== 'command-failed'
    || result.steps.length !== 1 || result.workspaceFiles.length !== 0 || !oracle) return undefined;
  const step = result.steps[0];
  if (!step || step.index !== 0 || step.exitCode !== 1
    || !Number.isSafeInteger(step.durationMs) || step.durationMs < 0 || step.durationMs > MAX_RUN_SECONDS * 1_000
    || !Number.isSafeInteger(step.stdoutBytes) || step.stdoutBytes < 0
    || !Number.isSafeInteger(step.stderrBytes) || step.stderrBytes < 0
    || step.stdoutBytes + step.stderrBytes > MAX_OUTPUT_BYTES
    || step.stdoutBytes !== oracle.stdoutBytes || step.stderrBytes !== oracle.stderrBytes) return undefined;
  return {
    status: 'failed',
    failureCode: 'command-failed',
    step: {
      index: 0,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      stdoutBytes: step.stdoutBytes,
      stderrBytes: step.stderrBytes,
    },
    workspaceFiles: 0,
    unchanged: true,
    oracle: {
      totalTests: oracle.totalTests,
      passed: oracle.passed,
      failed: oracle.failed,
      failedTest: oracle.failedTest,
      passedTests: oracle.passedTests,
      failureCategory: oracle.failureCategory,
    },
  };
}

async function runtimeCheck(
  request: Request,
  env: Env,
  dependencies: Required<Pick<LiveEntryDependencies, 'githubFor' | 'runnerFor' | 'runtimeTimeoutMs' | 'cleanupTimeoutMs'>>
    & Pick<LiveEntryDependencies, 'readWorkspace'>,
): Promise<Response> {
  if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length < 32 || env.ADMIN_TOKEN.length > 4_000) {
    return jsonResponse({ error: 'runtime-check-config-invalid' }, 503);
  }
  if (!await isAdmin(request, env.ADMIN_TOKEN)) return jsonResponse({ error: 'unauthorized' }, 401);
  try {
    await requireEmptyBody(request);
  } catch (error) {
    const code = error instanceof LiveRuntimeCheckError ? error.code : 'runtime-check-body-invalid';
    return jsonResponse({ error: code }, code.endsWith('timeout') ? 408 : 400);
  }

  const namespace = Reflect.get(env, 'SANDBOX');
  if (env.GITHUB_APP_ID !== '5266090' || typeof env.GITHUB_PRIVATE_KEY !== 'string'
    || env.GITHUB_PRIVATE_KEY.length < 1 || !namespace || typeof namespace !== 'object') {
    return jsonResponse({ error: 'runtime-check-config-invalid' }, 503);
  }

  let github: Pick<TargetWorkspaceGitHubPort, 'readTargetWorkspace'>;
  try {
    github = dependencies.githubFor(env);
  } catch {
    return jsonResponse({ error: 'runtime-check-github-client-unavailable' }, 503);
  }
  let snapshot: TargetWorkspaceSnapshot;
  try {
    const read = dependencies.readWorkspace
      ? dependencies.readWorkspace(github)
      : github.readTargetWorkspace({
        installationId: FIXTURE.installationId,
        target: { owner: FIXTURE.owner, name: FIXTURE.name, fullName: FIXTURE.fullName },
        commit: FIXTURE.baseCommit,
        excludedPathPatterns: FIXTURE.excludedPathPatterns,
        maxFiles: 128,
        maxFileBytes: 500_000,
        maxBytes: 2_000_000,
        maxDirectories: 512,
        maxPathBytes: DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxPathBytes,
        maxPathDepth: DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxPathDepth,
        maxJobSeconds: MAX_READ_SECONDS,
      });
    snapshot = await bounded(read, (MAX_READ_SECONDS + 5) * 1_000, 'runtime-check-github-timeout');
  } catch (error) {
    return jsonResponse({ error: error instanceof LiveRuntimeCheckError ? error.code : 'runtime-check-github-read-failed' }, 503);
  }
  if (!validSnapshot(snapshot)) return jsonResponse({ error: 'runtime-check-fixture-mismatch' }, 409);

  let inputDigest: string;
  try {
    inputDigest = await snapshotDigest(snapshot);
  } catch {
    return jsonResponse({ error: 'runtime-check-fixture-hash-failed' }, 503);
  }

  let oracleObservationCount = 0;
  let oracleProof: FixedOracleProof | undefined;
  const observeVerificationOutput = (observation: VerificationOutputObservation): void => {
    oracleObservationCount++;
    if (oracleObservationCount !== 1) {
      oracleProof = undefined;
      return;
    }
    oracleProof = fixedOracleProof(observation);
  };

  let runner: Pick<RuntimeRunner, 'verify' | 'cancel'>;
  try {
    runner = dependencies.runnerFor(namespace as SandboxNamespace, observeVerificationOutput);
  } catch {
    return jsonResponse({ error: 'runtime-check-runner-unavailable' }, 503);
  }
  let result: VerificationResult | undefined;
  let timedOut = false;
  try {
    result = await bounded(runner.verify(makeRunnerRequest(snapshot)), dependencies.runtimeTimeoutMs, 'runtime-check-runner-timeout');
  } catch (error) {
    timedOut = error instanceof LiveRuntimeCheckError && error.code === 'runtime-check-runner-timeout';
    try {
      await bounded(runner.cancel(FIXTURE.jobId), dependencies.cleanupTimeoutMs, 'runtime-check-cleanup-timeout');
    } catch {
      return jsonResponse({
        error: timedOut ? 'runtime-check-runner-timeout' : 'runtime-check-runner-failed',
        cleanup: 'failed-or-pending',
      }, 503);
    }
    return jsonResponse({
      error: timedOut ? 'runtime-check-runner-timeout' : 'runtime-check-runner-failed',
      cleanup: 'confirmed',
    }, 503);
  }

  const evidence = expectedFailureEvidence(result, oracleObservationCount === 1 ? oracleProof : undefined);
  if (!evidence) return jsonResponse({ error: 'runtime-check-result-unexpected' }, 409);
  return jsonResponse({
    status: 'ready',
    expectedFailureObserved: true,
    repository: FIXTURE.fullName,
    commit: FIXTURE.baseCommit,
    inputWorkspaceSha256: inputDigest,
    verification: evidence,
  }, 200);
}

export function createLiveWorker(dependencies: LiveEntryDependencies = {}): LiveWorker {
  const baseWorker = dependencies.baseWorker ?? defaultWorker;
  let runtimeCheckActive = false;
  const resolved = {
    githubFor: dependencies.githubFor ?? (env => new GitHubAppClient({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
    })),
    runnerFor: dependencies.runnerFor ?? ((namespace, observer) => createSandboxRunner({
      namespace,
      observeVerificationOutput: observer,
    })),
    runtimeTimeoutMs: dependencies.runtimeTimeoutMs ?? (MAX_RUN_SECONDS + 10) * 1_000,
    cleanupTimeoutMs: dependencies.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
    ...(dependencies.readWorkspace ? { readWorkspace: dependencies.readWorkspace } : {}),
  };
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/admin/runtime-check') {
        if (runtimeCheckActive) return jsonResponse({ error: 'runtime-check-already-active' }, 409);
        runtimeCheckActive = true;
        return await runtimeCheck(request, env, resolved).finally(() => {
          runtimeCheckActive = false;
        });
      }
      return baseWorker.fetch(request, env, context);
    },
    scheduled(event, env, context) {
      baseWorker.scheduled(event, env, context);
    },
    queue(batch, env, context) {
      return baseWorker.queue(batch, env, context);
    },
  };
}

const liveWorker = createLiveWorker();

export default liveWorker;
