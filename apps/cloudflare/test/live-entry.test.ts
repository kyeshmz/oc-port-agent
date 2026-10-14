import { describe, expect, it, vi } from 'vitest';
import type { Env, ExecutionContextBinding, QueueBatchBinding, ScheduledEventBinding } from '../src/env.js';
import type { RunnerRequest, VerificationResult } from '../src/contracts.js';
import type { VerificationOutputObservation } from '../src/sandbox.js';

vi.mock('../src/index.js', () => ({
  default: {
    fetch: async () => new Response(JSON.stringify({ delegated: true }), { status: 202 }),
    scheduled: () => undefined,
    queue: async () => undefined,
  },
  TargetJobDO: class TargetJobDO {},
  Sandbox: class Sandbox {},
}));

import { createLiveWorker } from '../src/live-entry.js';

const TOKEN = 'synthetic-live-runtime-admin-token';
const BASE_COMMIT = '8cf62db4e306d8b40cdf7cb4a7b016333ded6655';
const BOM_TAP = `TAP version 13
# Subtest: remove exactly one leading BOM, preserving repeated and interior BOMs
not ok 1 - remove exactly one leading BOM, preserving repeated and interior BOMs
  ---
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    '\uFEFFplain' !== 'plain'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  operator: 'strictEqual'
  ...
# Subtest: reject nonstrings without coercion
ok 2 - reject nonstrings without coercion
# Subtest: preserve the target-only helper
ok 3 - preserve the target-only helper
1..3
# tests 3
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ADMIN_TOKEN: TOKEN,
    GITHUB_APP_ID: '5266090',
    GITHUB_PRIVATE_KEY: 'synthetic-not-a-private-key',
    ...overrides,
  } as Env;
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  const file = (path: string, content: string) => ({
    path,
    content,
    sizeBytes: new TextEncoder().encode(content).byteLength,
    mode: '100644' as const,
  });
  const files = [
    file('lib/strip-prefix.js', 'export function stripPrefix(value) { return value; }\n'),
    file('lib/target-helpers.js', 'export const targetOnly = true;\n'),
    file('test/strip-prefix.test.mjs', 'import test from "node:test";\ntest("fixed", () => {});\n'),
    file('package.json', '{"private":true}\n'),
  ];
  return {
    repository: { owner: 'kyeshmz', name: 'oc-port-agent-live-test-20261010', fullName: 'kyeshmz/oc-port-agent-live-test-20261010' },
    commit: BASE_COMMIT,
    files,
    ...overrides,
  };
}

function verificationFor(
  exitCode: number | null,
  stdout: string,
  stderr = '',
  failureCode: VerificationResult['failureCode'] = 'command-failed',
): VerificationResult {
  return {
    status: 'failed',
    failureCode,
    steps: [{
      index: 0,
      exitCode,
      durationMs: 25,
      stdoutBytes: new TextEncoder().encode(stdout).byteLength,
      stderrBytes: new TextEncoder().encode(stderr).byteLength,
    }],
    workspaceFiles: [],
  };
}

function failedVerification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    ...verificationFor(1, BOM_TAP),
    ...overrides,
  };
}

function dependencies(options: {
  verification?: VerificationResult;
  snapshot?: ReturnType<typeof makeSnapshot>;
  githubError?: boolean;
  verifyError?: boolean;
  cleanupError?: boolean;
  runnerPromise?: Promise<VerificationResult>;
  runtimeTimeoutMs?: number;
  emitOracle?: boolean;
  oracleObservation?: Partial<VerificationOutputObservation>;
} = {}) {
  const context = { waitUntil: vi.fn() } as unknown as ExecutionContextBinding;
  const baseWorker = {
    fetch: vi.fn(async () => new Response(JSON.stringify({ delegated: true }), { status: 202 })),
    scheduled: vi.fn(),
    queue: vi.fn(async () => undefined),
  };
  const github = {
    readTargetWorkspace: vi.fn(async (input: unknown) => {
      if (options.githubError) throw new Error('synthetic private detail');
      return options.snapshot ?? makeSnapshot();
    }),
  };
  let observeVerificationOutput: ((observation: VerificationOutputObservation) => void) | undefined;
  const runner = {
    verify: vi.fn(async (request: RunnerRequest) => {
      if (options.verifyError) throw new Error('synthetic runner detail');
      if (options.runnerPromise) return options.runnerPromise;
      if (options.emitOracle !== false) {
        observeVerificationOutput?.({
          jobId: 'live-runtime-check',
          targetFullName: 'kyeshmz/oc-port-agent-live-test-20261010',
          targetBaseCommit: BASE_COMMIT,
          verificationCount: 1,
          index: 0,
          command: 'node',
          args: ['--test', 'test/strip-prefix.test.mjs'],
          exitCode: 1,
          timedOut: false,
          truncated: false,
          stdout: BOM_TAP,
          stderr: '',
          ...options.oracleObservation,
        });
      }
      return options.verification ?? failedVerification();
    }),
    cancel: vi.fn(async () => {
      if (options.cleanupError) throw new Error('synthetic cleanup detail');
    }),
  };
  const namespace = { testBinding: true };
  const worker = createLiveWorker({
    baseWorker,
    githubFor: vi.fn(() => github),
    runnerFor: vi.fn((binding, observer) => {
      expect(binding).toBe(namespace);
      observeVerificationOutput = observer;
      return runner;
    }),
    runtimeTimeoutMs: options.runtimeTimeoutMs ?? 1_000,
  });
  return { worker, env: env({ SANDBOX: namespace }), context, baseWorker, github, runner, namespace };
}

async function runtimeRequest(token = TOKEN, body?: string): Promise<Request> {
  return new Request('https://worker.test/admin/runtime-check', {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

describe('dedicated live profile wrapper', () => {
  it('delegates normal fetch, scheduled, and queue entrypoints unchanged', async () => {
    const h = dependencies();
    const fetchResponse = await h.worker.fetch(new Request('https://worker.test/health'), h.env, h.context);
    expect(fetchResponse.status).toBe(202);
    expect(await fetchResponse.json()).toEqual({ delegated: true });
    expect(h.baseWorker.fetch).toHaveBeenCalledOnce();

    const scheduledEvent = { scheduledTime: Date.now() } as ScheduledEventBinding;
    h.worker.scheduled(scheduledEvent, h.env, h.context);
    expect(h.baseWorker.scheduled).toHaveBeenCalledWith(scheduledEvent, h.env, h.context);

    const batch = { messages: [] } as unknown as QueueBatchBinding;
    await h.worker.queue(batch, h.env, h.context);
    expect(h.baseWorker.queue).toHaveBeenCalledWith(batch, h.env, h.context);
  });

  it('authenticates before GitHub or Sandbox boundaries and rejects a body', async () => {
    const unauthorized = dependencies();
    const response = await unauthorized.worker.fetch(await runtimeRequest('wrong-token'), unauthorized.env, unauthorized.context);
    expect(response.status).toBe(401);
    expect(unauthorized.github.readTargetWorkspace).not.toHaveBeenCalled();
    expect(unauthorized.runner.verify).not.toHaveBeenCalled();

    const nonempty = dependencies();
    const bodyResponse = await nonempty.worker.fetch(await runtimeRequest(TOKEN, '{}'), nonempty.env, nonempty.context);
    expect(bodyResponse.status).toBe(400);
    expect(await bodyResponse.json()).toEqual({ error: 'runtime-check-body-not-empty' });
    expect(nonempty.github.readTargetWorkspace).not.toHaveBeenCalled();
  });

  it('pins the fixture and uses the fixed no-edit verifier request, returning only whitelisted evidence', async () => {
    const h = dependencies();
    const response = await h.worker.fetch(await runtimeRequest(), h.env, h.context);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe('ready');
    expect(body.expectedFailureObserved).toBe(true);
    expect(body.repository).toBe('kyeshmz/oc-port-agent-live-test-20261010');
    expect(body.commit).toBe(BASE_COMMIT);
    expect(body.verification).toMatchObject({
      status: 'failed',
      failureCode: 'command-failed',
      workspaceFiles: 0,
      unchanged: true,
      step: { index: 0, exitCode: 1 },
      oracle: {
        totalTests: 3,
        passed: 2,
        failed: 1,
        failedTest: 'remove exactly one leading BOM, preserving repeated and interior BOMs',
        passedTests: ['reject nonstrings without coercion', 'preserve the target-only helper'],
        failureCategory: 'ERR_ASSERTION/strictEqual/BOM-mismatch',
      },
    });
    expect(JSON.stringify(body)).not.toContain('export function stripPrefix');
    expect(JSON.stringify(body)).not.toContain('synthetic-live-runtime-admin-token');

    expect(h.github.readTargetWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 170044765,
      target: { owner: 'kyeshmz', name: 'oc-port-agent-live-test-20261010', fullName: 'kyeshmz/oc-port-agent-live-test-20261010' },
      commit: BASE_COMMIT,
      maxJobSeconds: 30,
    }));
    const request = h.runner.verify.mock.calls[0]?.[0];
    if (!request) throw new Error('runner was not called with a request');
    expect(request).toMatchObject({
      jobId: 'live-runtime-check',
      edits: [],
      verification: [{ command: 'node', args: ['--test', 'test/strip-prefix.test.mjs'], timeoutSeconds: 30 }],
      maxJobSeconds: 120,
      remainingJobSeconds: 120,
      maxOutputBytes: 16_384,
      verificationWorkspace: { complete: true, commit: BASE_COMMIT },
    });
    expect(request.target.files.map(file => file.path)).toEqual(['lib/strip-prefix.js', 'lib/target-helpers.js']);
  });

  it('fails closed on changed repository, pinned commit, paths, or incomplete fixture', async () => {
    const snapshots = [
      makeSnapshot({ repository: { owner: 'someone-else', name: 'other', fullName: 'someone-else/other' } }),
      makeSnapshot({ commit: 'a'.repeat(40) }),
      makeSnapshot({ files: makeSnapshot().files.filter(file => file.path !== 'test/strip-prefix.test.mjs') }),
      makeSnapshot({ files: [{ ...makeSnapshot().files[0], path: '../escape.js' }] }),
    ];
    for (const snapshot of snapshots) {
      const h = dependencies({ snapshot });
      const response = await h.worker.fetch(await runtimeRequest(), h.env, h.context);
      expect(response.status).toBe(409);
      expect(h.runner.verify).not.toHaveBeenCalled();
    }
  });

  it('refuses a fake pass and any mutation evidence as proof of the expected trusted failure', async () => {
    for (const verification of [
      { status: 'passed', steps: [{ index: 0, exitCode: 0, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 }], workspaceFiles: [] } as VerificationResult,
      failedVerification({ workspaceFiles: [{ path: 'test/strip-prefix.test.mjs', operation: 'write', sha256: 'a'.repeat(64), mode: '100644' }] }),
      failedVerification({ failureCode: 'forbidden-mutation' }),
    ]) {
      const h = dependencies({ verification });
      const response = await h.worker.fetch(await runtimeRequest(), h.env, h.context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'runtime-check-result-unexpected' });
    }
  });

  it('requires the exact fixed Node TAP assertion evidence, not just a command-failed summary', async () => {
    const launcher = 'launcher: failed to execute Node';
    const importFailure = 'Error [ERR_MODULE_NOT_FOUND]: cannot load test/strip-prefix.test.mjs';
    const missingTest = BOM_TAP.replace('ok 3 - preserve the target-only helper\n', '').replace('# tests 3', '# tests 2').replace('# pass 2', '# pass 1');
    const wrongTest = BOM_TAP.replace('remove exactly one leading BOM, preserving repeated and interior BOMs', 'some unrelated failing test');
    const wrongAssertion = BOM_TAP.replace("code: 'ERR_ASSERTION'", "code: 'ERR_MODULE_NOT_FOUND'");
    const noBomMismatch = BOM_TAP.replace("'\uFEFFplain' !== 'plain'", "'plain' !== 'plain'");
    const cases: Array<[string, Parameters<typeof dependencies>[0]]> = [
      ['launcher exit 126', { oracleObservation: { exitCode: 126, stdout: launcher }, verification: verificationFor(126, launcher) }],
      ['missing executable exit 127', { oracleObservation: { exitCode: 127, stdout: 'node: not found' }, verification: verificationFor(127, 'node: not found') }],
      ['import or syntax failure', { oracleObservation: { stdout: importFailure }, verification: verificationFor(1, importFailure) }],
      ['signal exit', { oracleObservation: { exitCode: null, stdout: BOM_TAP }, verification: verificationFor(null, BOM_TAP) }],
      ['missing test', { oracleObservation: { stdout: missingTest }, verification: verificationFor(1, missingTest) }],
      ['wrong test name', { oracleObservation: { stdout: wrongTest }, verification: verificationFor(1, wrongTest) }],
      ['wrong assertion category', { oracleObservation: { stdout: wrongAssertion }, verification: verificationFor(1, wrongAssertion) }],
      ['no BOM mismatch', { oracleObservation: { stdout: noBomMismatch }, verification: verificationFor(1, noBomMismatch) }],
      ['timeout', {
        oracleObservation: { timedOut: true, exitCode: null },
        verification: verificationFor(null, BOM_TAP, '', 'timed-out'),
      }],
      ['truncated TAP', {
        oracleObservation: { truncated: true },
        verification: verificationFor(1, BOM_TAP, '', 'output-limit'),
      }],
      ['observer never ran', { emitOracle: false }],
    ];
    for (const [name, options] of cases) {
      const h = dependencies(options);
      const response = await h.worker.fetch(await runtimeRequest(), h.env, h.context);
      if (response.status !== 409) throw new Error(`oracle case unexpectedly returned ${response.status}: ${name}`);
      expect(response.status, name).toBe(409);
      expect(await response.json(), name).toEqual({ error: 'runtime-check-result-unexpected' });
    }
  });

  it('returns bounded generic failures and reports timeout cleanup truthfully', async () => {
    const githubError = dependencies({ githubError: true });
    const githubResponse = await githubError.worker.fetch(await runtimeRequest(), githubError.env, githubError.context);
    expect(githubResponse.status).toBe(503);
    expect(await githubResponse.json()).toEqual({ error: 'runtime-check-github-read-failed' });

    const timeout = dependencies({
      runtimeTimeoutMs: 5,
      runnerPromise: new Promise(() => undefined),
    });
    const timeoutResponse = await timeout.worker.fetch(await runtimeRequest(), timeout.env, timeout.context);
    expect(timeoutResponse.status).toBe(503);
    expect(await timeoutResponse.json()).toEqual({ error: 'runtime-check-runner-timeout', cleanup: 'confirmed' });
    expect(timeout.runner.cancel).toHaveBeenCalledWith('live-runtime-check');

    const cleanupFailure = dependencies({
      runtimeTimeoutMs: 5,
      runnerPromise: new Promise(() => undefined),
      cleanupError: true,
    });
    const cleanupResponse = await cleanupFailure.worker.fetch(await runtimeRequest(), cleanupFailure.env, cleanupFailure.context);
    expect(cleanupResponse.status).toBe(503);
    expect(await cleanupResponse.json()).toEqual({
      error: 'runtime-check-runner-timeout',
      cleanup: 'failed-or-pending',
    });
  });

  it('rejects mismatched live bindings and delegates unsupported paths', async () => {
    const h = dependencies();
    const wrongApp = env({ SANDBOX: h.namespace, GITHUB_APP_ID: 'other' });
    const response = await h.worker.fetch(await runtimeRequest(), wrongApp, h.context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'runtime-check-config-invalid' });
    expect(h.github.readTargetWorkspace).not.toHaveBeenCalled();

    const notTheRoute = await h.worker.fetch(new Request('https://worker.test/admin/runtime-check', { method: 'GET' }), h.env, h.context);
    expect(notTheRoute.status).toBe(202);
    expect(h.baseWorker.fetch).toHaveBeenCalledOnce();
  });
});
