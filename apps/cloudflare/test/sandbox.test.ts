import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type {
  AgentOutput,
  AgentRequest,
  CorePorts,
  DiscoveredPlan,
  DraftPublication,
  DraftPublicationRequest,
  GitHubPort,
  JobRecord,
  NewJobRecord,
  PinnedPlan,
  RunnerRequest,
  SnapshotFile,
  StorePort,
  TargetSnapshot,
  TrackingRegistration,
  PullRequestLifecycle,
  VerificationResult,
  VerificationWorkspaceSnapshot,
  VerifiedMergeObservation,
} from '../src/contracts.js';
import { runJob } from '../src/core.js';
import { DEFAULT_LIMITS, parsePolicy, policyHash } from '../src/policy.js';
import {
  createSandboxRunner,
  SandboxRunnerError,
  sandboxVerifierBootstrapMetadata,
  type RunnerSandbox,
} from '../src/sandbox.js';
import {
  RUNNER_PRIVILEGE_DROP_SOURCE,
  RUNNER_PRIVILEGE_DROP_SHA256,
  TRUSTED_VERIFIER_HELPER_GZIP_BASE64,
  TRUSTED_VERIFIER_HELPER_SHA256,
} from '../src/sandbox-helper-assets.js';

const targetCommit = 'b'.repeat(40);
const sourceCommit = 'a'.repeat(40);
const execFileAsync = promisify(execFile);
const launcherHarness = String.raw`
import json, os, pwd, sys
from types import SimpleNamespace
from unittest.mock import patch

launcher = {"__name__": "launcher_test"}
exec(compile(sys.argv[1], "run-as-runner.py", "exec"), launcher)
captured = {}
runner = SimpleNamespace(pw_uid=1000, pw_gid=1000)
capture = lambda executable, argv, environment: captured.update({"executable": executable, "argv": argv, "environment": environment})
with patch.object(launcher["pwd"], "getpwnam", return_value=runner), \
     patch.object(launcher["sys"], "argv", ["run-as-runner.py", "npm", "test"]), \
     patch.object(launcher["os"], "geteuid", side_effect=[0, 1000]), \
     patch.object(launcher["os"], "getuid", side_effect=[0, 1000]), \
     patch.object(launcher["os"], "getgid", return_value=1000), \
     patch.object(launcher["os"], "getegid", return_value=1000), \
     patch.object(launcher["os"], "getgroups", return_value=[]), \
     patch.object(launcher["os"], "setgroups"), \
     patch.object(launcher["os"], "setgid"), \
     patch.object(launcher["os"], "setuid"), \
     patch.object(launcher["os"], "execvpe", side_effect=capture):
    exit_code = launcher["main"]()
print(json.dumps({"exit": exit_code, "child": captured}))
`;

async function runPrivilegeDropLauncher(environment: Record<string, string>): Promise<{ exit: number; child: Record<string, unknown> }> {
  const python = (await execFileAsync('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const output = await execFileAsync(python, ['-c', launcherHarness, RUNNER_PRIVILEGE_DROP_SOURCE], {
    env: environment as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 100_000,
  });
  return JSON.parse(output.stdout) as { exit: number; child: Record<string, unknown> };
}

const plan: PinnedPlan = {
  trackingId: 'tracking-1',
  installationId: 42,
  target: { owner: 'target-org', name: 'target', fullName: 'target-org/target' },
  baseBranch: 'main',
  targetBaseCommit: targetCommit,
  upstreamRepository: 'https://github.com/upstream-org/project.git',
  upstreamRef: 'main',
  fromCommit: 'c'.repeat(40),
  expectedLastCheckedCommit: 'c'.repeat(40),
  toCommit: sourceCommit,
  commitCount: 1,
  changedFiles: [{ path: 'src/parser.ts', status: 'modified' }],
  changedPaths: ['src/parser.ts'],
  checkedChangedPaths: ['src/parser.ts'],
  observedAt: '2026-10-09T12:00:00.000Z',
  jobId: 'job-1',
  jobKey: 'job-1',
  policyHash: 'd'.repeat(64),
  selectedUpstreamPaths: ['src/parser.ts'],
  checkedSelectedUpstreamPaths: ['src/parser.ts'],
  selectedSelectionIds: ['parser'],
};

const original = 'export const parse = () => 1;\n';
const staged = 'export const parse = () => 2;\n';
const fixedTest = 'assert.equal(parse("x"), 2);\n';
const fixedHelper = 'def assert_parser():\n    assert True\n';

function bootstrapStatus(): {
  schemaVersion: 1;
  status: 'ready';
  directories: Array<{ path: string; uid: number; gid: number; mode: string }>;
  files: Array<{ path: string; sha256: string; uid: number; gid: number; mode: string }>;
  runner: { name: 'runner'; uid: number; gid: number };
} {
  return {
    schemaVersion: 1,
    status: 'ready',
    directories: sandboxVerifierBootstrapMetadata.directories.map(item => ({ ...item })),
    files: sandboxVerifierBootstrapMetadata.files.map(item => ({ ...item })),
    runner: { name: 'runner', uid: 1000, gid: 1000 },
  };
}

function file(path: string, content: string, mode: SnapshotFile['mode'] = '100644'): SnapshotFile {
  return { path, content, sizeBytes: new TextEncoder().encode(content).byteLength, mode };
}

const pinnedTarget: TargetSnapshot = {
  repository: plan.target,
  baseBranch: 'main',
  commit: targetCommit,
  existingPaths: ['lib/parser.ts'],
  files: [file('lib/parser.ts', original)],
};

const completeSnapshot: TargetSnapshot = {
  repository: plan.target,
  baseBranch: 'main',
  commit: targetCommit,
  existingPaths: ['lib/parser.ts', 'tests/fixed.spec.ts', 'tests/helper.py'],
  files: [file('lib/parser.ts', original), file('tests/fixed.spec.ts', fixedTest), file('tests/helper.py', fixedHelper)],
};

const verificationWorkspace: VerificationWorkspaceSnapshot = { complete: true, ...completeSnapshot };

function runnerRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    jobId: 'job-1',
    plan,
    target: pinnedTarget,
    verificationWorkspace,
    edits: [{ path: 'lib/parser.ts', operation: 'write', content: staged }],
    verification: [{ command: 'npm', args: ['test'], timeoutSeconds: 5 }],
    maxOutputBytes: 1_000,
    maxJobSeconds: 60,
    remainingJobSeconds: 30,
    ...overrides,
  };
}

type ProcessOutputOptions = Parameters<Awaited<ReturnType<RunnerSandbox['exec']>>['output']>[0];
type ProcessOutputResult = Awaited<ReturnType<Awaited<ReturnType<RunnerSandbox['exec']>>['output']>>;

class FakeSandbox {
  readonly files = new Map<string, { content: string; mode: string }>();
  readonly imageFiles = new Map<string, { content: string; mode: string; uid: number; gid: number }>();
  readonly commandEnvironments: Record<string, string>[] = [];
  readonly commandArgv: string[][] = [];
  startOptions: { enableInternet?: boolean } | undefined;
  destroyCount = 0;
  readonly destroyFailCalls = new Set<number>();
  mode: 'pass' | 'mutate' | 'fail' | 'timeout' | 'cancel' | 'stall-start' | 'stall-helper-start'
    | 'stall-command-start' | 'stall-kill' | 'bootstrap-wrong-digest' | 'bootstrap-wrong-mode'
    | 'bootstrap-wrong-owner' | 'bootstrap-wrong-runner-uid' | 'bootstrap-prerequisite-missing'
    | 'bootstrap-cancel' | 'bootstrap-output-limit' | 'bootstrap-malformed' | 'bootstrap-timeout'
    | 'bootstrap-stall-start' = 'pass';
  commandStarted: (() => void) | undefined;
  bootstrapStarted: (() => void) | undefined;
  private modeManifest: Array<{ path: string; mode: string }> = [];

  asSandbox(): RunnerSandbox {
    return {
      mkdir: async () => ({ success: true }),
      writeFile: async (path, content) => {
        if (path === '/tmp/ocpa-job-modes.json') {
          const parsed: unknown = JSON.parse(content);
          if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object'
            || Array.isArray(item) || typeof item.path !== 'string' || typeof item.mode !== 'string')) {
            throw new Error('invalid test mode manifest');
          }
          this.modeManifest = parsed.map(item => ({ path: item.path, mode: item.mode }));
        } else if (path.startsWith('/workspace/ocpa-job/')) {
          const relative = path.slice('/workspace/ocpa-job/'.length);
          this.files.set(relative, { content, mode: '100644' });
        }
        return { success: true };
      },
      start: async options => {
        this.startOptions = options;
        if (this.mode === 'stall-start') await new Promise<void>(() => undefined);
      },
      exec: async (argv, options) => {
        this.commandEnvironments.push(options.env);
        this.commandArgv.push([...argv]);
        let stdout = '';
        let exitCode = 0;
        let timedOut = false;
        let truncated = false;
        let hang = false;

        if (argv[0] === 'python3' && argv[1] === '-I' && argv[2] === '-c') {
          this.bootstrapStarted?.();
          if (this.mode === 'bootstrap-stall-start') await new Promise<void>(() => undefined);
          const verifierPath = '/opt/oc-port-agent/verify.py';
          const launcherPath = '/opt/oc-port-agent/run-as-runner.py';
          if (!this.imageFiles.has(verifierPath)) {
            this.imageFiles.set(verifierPath, {
              content: gunzipSync(Buffer.from(TRUSTED_VERIFIER_HELPER_GZIP_BASE64, 'base64')).toString('utf8'),
              mode: '0555',
              uid: 0,
              gid: 0,
            });
          }
          if (!this.imageFiles.has(launcherPath)) {
            this.imageFiles.set(launcherPath, {
              content: RUNNER_PRIVILEGE_DROP_SOURCE,
              mode: '0555',
              uid: 0,
              gid: 0,
            });
          }
          if (this.mode === 'bootstrap-prerequisite-missing') {
            exitCode = 2;
          } else if (this.mode === 'bootstrap-cancel') {
            hang = true;
          } else if (this.mode === 'bootstrap-malformed') {
            stdout = `${sandboxVerifierBootstrapMetadata.readyPrefix}{}`;
          } else if (this.mode === 'bootstrap-output-limit') {
            stdout = `${sandboxVerifierBootstrapMetadata.readyPrefix}${JSON.stringify(bootstrapStatus())}`;
            truncated = true;
          } else if (this.mode === 'bootstrap-timeout') {
            timedOut = true;
            exitCode = 124;
          } else {
            const status = bootstrapStatus();
            const verifier = status.files.find(item => item.path === '/opt/oc-port-agent/verify.py')!;
            if (this.mode === 'bootstrap-wrong-digest') verifier.sha256 = '0'.repeat(64);
            if (this.mode === 'bootstrap-wrong-mode') verifier.mode = '0444';
            if (this.mode === 'bootstrap-wrong-owner') verifier.uid = 1;
            if (this.mode === 'bootstrap-wrong-runner-uid') status.runner.uid = 0;
            stdout = `${sandboxVerifierBootstrapMetadata.readyPrefix}${JSON.stringify(status)}`;
          }
        } else if (argv[0] === 'python3' && argv[1] === '-I'
          && argv[2] === '/opt/oc-port-agent/run-as-runner.py') {
          this.commandStarted?.();
          if (this.mode === 'stall-command-start') await new Promise<void>(() => undefined);
          if (this.mode === 'mutate') this.files.set('tests/generated.log', { content: 'unapproved output\n', mode: '100644' });
          if (this.mode === 'fail') {
            stdout = 'sensitive test output';
            exitCode = 7;
          } else if (this.mode === 'timeout') {
            timedOut = true;
            exitCode = 124;
          } else if (this.mode === 'cancel') {
            hang = true;
          } else if (this.mode === 'stall-kill') {
            hang = true;
          } else {
            stdout = 'test output must not leave the sandbox';
          }
        } else if (argv[0] === 'python3' && argv[2] === 'reset') {
          this.files.clear();
          this.modeManifest = [];
        } else if (argv[0] === 'python3' && argv[2] === 'prepare') {
          for (const entry of this.modeManifest) {
            const existing = this.files.get(entry.path);
            if (existing) existing.mode = entry.mode;
          }
        } else if (argv[0] === 'python3' && argv[2] === 'inventory') {
          stdout = JSON.stringify(this.inventory());
        } else {
          exitCode = 2;
        }
        if (this.mode === 'stall-helper-start' && argv[0] === 'python3' && argv[2] === 'reset') {
          await new Promise<void>(() => undefined);
        }

        const process: Awaited<ReturnType<RunnerSandbox['exec']>> = {
          id: `process-${this.commandArgv.length}`,
          output: async (_outputOptions: ProcessOutputOptions): Promise<ProcessOutputResult> => {
            if (hang) {
              if (_outputOptions?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
              await new Promise<void>((_resolve, reject) => {
                _outputOptions?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
              });
            }
            return { stdout, stderr: '', exitCode, timedOut, truncated };
          },
          kill: async () => {
            if (this.mode === 'stall-kill') await new Promise<void>(() => undefined);
            else hang = false;
          },
        };
        return process;
      },
      destroy: async () => {
        this.destroyCount++;
        if (this.destroyFailCalls.has(this.destroyCount)) throw new Error('sandbox destroy failed');
      },
    };
  }

  private inventory(): { files: Array<{ path: string; sha256: string; mode: string; sizeBytes: number }>; directories: string[] } {
    const files = [...this.files.entries()].map(([path, entry]) => {
      const bytes = new TextEncoder().encode(entry.content);
      return {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mode: entry.mode,
        sizeBytes: bytes.byteLength,
      };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const directories = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
    }
    return { files, directories: [...directories].sort() };
  }
}

function setupFake(
  mode: FakeSandbox['mode'] = 'pass',
  expectedJobId: string | null = 'job-1',
  observeVerificationOutput?: NonNullable<Parameters<typeof createSandboxRunner>[0]['observeVerificationOutput']>,
) {
  const sandbox = new FakeSandbox();
  sandbox.mode = mode;
  let lookupCount = 0;
  const runner = createSandboxRunner({
    ...(observeVerificationOutput ? { observeVerificationOutput } : {}),
    sandboxForId: id => {
      lookupCount++;
      if (expectedJobId !== null) expect(id).toBe(`ocpa-verify-${expectedJobId.toLowerCase()}`);
      else expect(id).toMatch(/^ocpa-verify-job_[a-f0-9]{64}$/);
      return sandbox.asSandbox();
    },
  });
  return { runner, sandbox, lookupCount: () => lookupCount };
}

const coreFromCommit = 'c'.repeat(40);
const coreUpstreamCommit = 'a'.repeat(40);

function rawCorePolicy(): Record<string, unknown> {
  return {
    version: 1,
    upstream: { repository: plan.upstreamRepository, ref: 'main' },
    selections: [{
      id: 'parser',
      description: 'Port parser behavior.',
      upstreamPaths: ['src/**'],
      excludeUpstreamPaths: [],
      targetPaths: ['lib/**'],
      acceptance: ['Preserve parser behavior.'],
      mappings: [{ upstream: 'src/parser.ts', target: ['lib/parser.ts'] }],
    }],
    preserve: ['Keep fixed target tests unchanged.'],
    verification: [{ command: 'npm', args: ['test'], timeoutSeconds: 5 }],
    limits: { ...DEFAULT_LIMITS, maxJobSeconds: 60 },
  };
}

class CoreStore implements StorePort {
  readonly jobs = new Map<string, JobRecord>();
  readonly registration: TrackingRegistration;

  constructor(registration: TrackingRegistration) {
    this.registration = registration;
  }

  async createTrackingRegistration(): Promise<TrackingRegistration> { throw new Error('unused'); }
  async getTrackingRegistration(id: string): Promise<TrackingRegistration | undefined> {
    return id === this.registration.id ? this.registration : undefined;
  }
  async listActiveTrackingRegistrations(): Promise<{ registrations: readonly TrackingRegistration[] }> {
    return { registrations: [this.registration] };
  }
  async setTrackingRegistrationActive(): Promise<boolean> { return false; }
  async recordWebhookDelivery(): Promise<boolean> { return false; }
  async createOrGetJob(input: NewJobRecord): Promise<{ job: JobRecord; created: boolean }> {
    const existing = this.jobs.get(input.id);
    if (existing) return { job: existing, created: false };
    const timestamp = '2026-10-09T12:00:00.000Z';
    const job: JobRecord = {
      ...input,
      status: 'queued', stage: 'queued', version: 0, attempt: 0,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }
  async getJob(id: string): Promise<JobRecord | undefined> { return this.jobs.get(id); }
  async getJobByKey(key: string): Promise<JobRecord | undefined> { return [...this.jobs.values()].find(job => job.key === key); }
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
    if (!current || current.version !== expectedVersion || job.version !== expectedVersion + 1) throw new Error('CAS');
    this.jobs.set(job.id, job);
    return job;
  }
  async advanceLastCheckedCommit(input: { trackingId: string; expectedLastCheckedCommit: string; nextLastCheckedCommit: string; policyHash: string }): Promise<boolean> {
    if (input.trackingId !== this.registration.id || input.policyHash !== this.registration.policyHash) return false;
    if (this.registration.lastCheckedCommit === input.nextLastCheckedCommit) return true;
    if (this.registration.lastCheckedCommit !== input.expectedLastCheckedCommit) return false;
    this.registration.lastCheckedCommit = input.nextLastCheckedCommit;
    return true;
  }
  async activateLastSyncedCommit(): Promise<boolean> { return false; }
}

class CoreGitHub implements GitHubPort {
  publishCalls = 0;
  constructor(private readonly discovered: DiscoveredPlan) {}
  async verifyTrackingAccess() { return { targetAccessible: true, targetWritable: true, upstreamReadable: true }; }
  async discoverPlan(): Promise<DiscoveredPlan> { return this.discovered; }
  async readSourceSnapshot() {
    return {
      repository: plan.upstreamRepository,
      beforeCommit: coreFromCommit,
      beforeFiles: [file('src/parser.ts', 'export const parse = () => 1;\n')],
      commit: coreUpstreamCommit,
      files: [file('src/parser.ts', 'export const parse = () => 2;\n')],
      deletedPaths: [],
    };
  }
  async readTargetSnapshot() { return pinnedTarget; }
  async readVerificationWorkspace() { return verificationWorkspace; }
  async publishDraft(_input: DraftPublicationRequest): Promise<DraftPublication> {
    this.publishCalls++;
    throw new Error('Core must not publish');
  }
  async confirmMergedCheckpoint(): Promise<VerifiedMergeObservation | undefined> { return undefined; }
  async getPullRequestLifecycle(): Promise<PullRequestLifecycle> { return { status: 'unknown' }; }
}

function corePlan(): DiscoveredPlan {
  return {
    trackingId: 'tracking-1',
    installationId: 42,
    target: plan.target,
    baseBranch: 'main',
    targetBaseCommit: targetCommit,
  upstreamRepository: plan.upstreamRepository,
  upstreamRef: 'main',
  fromCommit: coreFromCommit,
  expectedLastCheckedCommit: coreFromCommit,
  toCommit: coreUpstreamCommit,
  commitCount: 1,
  changedFiles: [{ path: 'src/parser.ts', status: 'modified' }],
  changedPaths: ['src/parser.ts'],
  checkedChangedPaths: ['src/parser.ts'],
    observedAt: '2026-10-09T12:00:00.000Z',
  };
}

describe('isolated sandbox runner', () => {
  it.each([
    ['upstream pin', { ...plan, toCommit: 'not-a-commit' }],
    ['target pin', { ...plan, targetBaseCommit: 'a'.repeat(39) }],
  ] as const)('rejects malformed %s before looking up a sandbox or starting a process', async (_name, invalidPlan) => {
    const { runner, sandbox, lookupCount } = setupFake();

    await expect(runner.verify(runnerRequest({ plan: invalidPlan })))
      .rejects.toMatchObject({ code: 'runner-plan-pin-invalid' });
    expect(lookupCount()).toBe(0);
    expect(sandbox.commandArgv).toEqual([]);
    expect(sandbox.destroyCount).toBe(0);
  });

  it('bundles the exact current verifier and a digest-pinned privilege-drop launcher', () => {
    const verifierPath = fileURLToPath(new URL('../container/verify.py', import.meta.url));
    const currentVerifier = readFileSync(verifierPath, 'utf8');
    const bundledVerifier = gunzipSync(Buffer.from(TRUSTED_VERIFIER_HELPER_GZIP_BASE64, 'base64')).toString('utf8');

    expect(bundledVerifier).toBe(currentVerifier);
    expect(createHash('sha256').update(bundledVerifier).digest('hex')).toBe(TRUSTED_VERIFIER_HELPER_SHA256);
    expect(createHash('sha256').update(RUNNER_PRIVILEGE_DROP_SOURCE).digest('hex')).toBe(RUNNER_PRIVILEGE_DROP_SHA256);
    expect(RUNNER_PRIVILEGE_DROP_SOURCE).toContain('os.setgroups([])');
    expect(RUNNER_PRIVILEGE_DROP_SOURCE).toContain('os.setuid(account.pw_uid)');
  });

  it('bootstraps a fresh prebuilt image before reset or test execution with no secret environment', async () => {
    const { runner, sandbox } = setupFake();
    const result = await runner.verify(runnerRequest());

    expect(result.status).toBe('passed');
    expect(sandbox.startOptions).toEqual({ enableInternet: false });
    const bootstrapIndex = sandbox.commandArgv.findIndex(argv => argv[1] === '-I' && argv[2] === '-c');
    const resetIndex = sandbox.commandArgv.findIndex(argv => argv[2] === 'reset');
    const testIndex = sandbox.commandArgv.findIndex(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py');
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeLessThan(resetIndex);
    expect(resetIndex).toBeLessThan(testIndex);
    expect(sandbox.commandArgv[bootstrapIndex]?.[3]).toContain('OCPA_VERIFIER_BOOTSTRAP_V1');
    expect(sandbox.imageFiles.get('/opt/oc-port-agent/verify.py')).toMatchObject({
      content: gunzipSync(Buffer.from(TRUSTED_VERIFIER_HELPER_GZIP_BASE64, 'base64')).toString('utf8'),
      mode: '0555', uid: 0, gid: 0,
    });
    expect(sandbox.commandArgv[testIndex]).toEqual([
      'python3', '-I', '/opt/oc-port-agent/run-as-runner.py', 'npm', 'test',
    ]);
    expect(sandbox.commandEnvironments[testIndex]).toMatchObject({
      OC_PORT_UPSTREAM_COMMIT: plan.toCommit,
      OC_PORT_TARGET_COMMIT: plan.targetBaseCommit,
      OC_PORT_HAS_SELECTIONS: 'true',
    });
    expect(sandbox.commandEnvironments[bootstrapIndex]).not.toHaveProperty('OC_PORT_UPSTREAM_COMMIT');
    expect(sandbox.commandArgv.some(argv => argv[0] === '/usr/bin/setpriv')).toBe(false);
    expect(sandbox.commandEnvironments.every(environment =>
      !Object.keys(environment).some(key => /TOKEN|KEY|SECRET|PRIVATE/i.test(key)))).toBe(true);
  });

  it.each([
    ['selected source changes', ['parser'], 'true'],
    ['unselected source changes', [], 'false'],
  ] as const)('preserves only trusted plan metadata through the real nonroot launcher for %s', async (_label, selectionIds, expectedSelection) => {
    const { runner, sandbox } = setupFake();
    const forgedPlan = {
      ...plan,
      selectedSelectionIds: [...selectionIds],
      OC_PORT_UPSTREAM_COMMIT: 'f'.repeat(40),
      OC_PORT_TARGET_COMMIT: 'e'.repeat(40),
      OC_PORT_HAS_SELECTIONS: 'false',
    } as typeof plan;
    const request = runnerRequest({ plan: forgedPlan });
    const result = await runner.verify(request);

    expect(result.status).toBe('passed');
    const commandIndex = sandbox.commandArgv.findIndex(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py');
    const workerEnvironment = sandbox.commandEnvironments[commandIndex];
    expect(workerEnvironment).toMatchObject({
      OC_PORT_UPSTREAM_COMMIT: plan.toCommit,
      OC_PORT_TARGET_COMMIT: plan.targetBaseCommit,
      OC_PORT_HAS_SELECTIONS: expectedSelection,
    });
    const launcherResult = await runPrivilegeDropLauncher({
      ...workerEnvironment,
      GH_TOKEN: 'test-only-not-a-credential',
      OPENCODE_API_KEY: 'test-only-not-a-key',
      OC_PORT_MODEL_TEXT: 'untrusted model text',
    });
    expect(launcherResult.exit).toBe(127);
    expect(launcherResult.child).toEqual({
      executable: 'npm',
      argv: ['npm', 'test'],
      environment: workerEnvironment,
    });

    for (const malformed of [
      { ...workerEnvironment, OC_PORT_UPSTREAM_COMMIT: 'not-a-commit' },
      { ...workerEnvironment, OC_PORT_TARGET_COMMIT: 'b'.repeat(39) },
      { ...workerEnvironment, OC_PORT_HAS_SELECTIONS: 'yes' },
    ]) {
      const rejected = await runPrivilegeDropLauncher(malformed);
      expect(rejected).toEqual({ exit: 126, child: {} });
    }
  });

  it('preserves the exact root-owned immutable verifier already in the custom image', async () => {
    const { runner, sandbox } = setupFake();
    const verifierPath = '/opt/oc-port-agent/verify.py';
    const verifier = gunzipSync(Buffer.from(TRUSTED_VERIFIER_HELPER_GZIP_BASE64, 'base64')).toString('utf8');
    const existing = { content: verifier, mode: '0555', uid: 0, gid: 0 };
    sandbox.imageFiles.set(verifierPath, existing);

    const result = await runner.verify(runnerRequest());

    expect(result.status).toBe('passed');
    expect(sandbox.imageFiles.get(verifierPath)).toBe(existing);
    expect(sandbox.imageFiles.get(verifierPath)).toEqual({ content: verifier, mode: '0555', uid: 0, gid: 0 });
  });

  it.each([
    ['unexpected helper digest', 'bootstrap-wrong-digest'],
    ['unexpected helper permissions', 'bootstrap-wrong-mode'],
    ['unexpected helper owner', 'bootstrap-wrong-owner'],
    ['root runner UID', 'bootstrap-wrong-runner-uid'],
  ] as const)('rejects %s before target tests', async (_label, mode) => {
    const { runner, sandbox } = setupFake(mode);

    await expect(runner.verify(runnerRequest())).rejects.toMatchObject({ code: 'runner-bootstrap-rejected' });
    expect(sandbox.commandArgv.some(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py')).toBe(false);
    expect(sandbox.commandArgv.some(argv => argv[2] === 'reset')).toBe(false);
    expect(sandbox.files.size).toBe(0);
  });

  it('fails closed before target materialization when a bootstrap prerequisite is unavailable', async () => {
    const { runner, sandbox } = setupFake('bootstrap-prerequisite-missing');

    await expect(runner.verify(runnerRequest())).rejects.toMatchObject({ code: 'runner-bootstrap-rejected' });
    expect(sandbox.commandArgv.some(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py')).toBe(false);
    expect(sandbox.commandArgv.some(argv => argv[2] === 'reset')).toBe(false);
    expect(sandbox.files.size).toBe(0);
  });

  it.each([
    ['truncated output', 'bootstrap-output-limit'],
    ['malformed readiness metadata', 'bootstrap-malformed'],
    ['bootstrap process timeout', 'bootstrap-timeout'],
  ] as const)('rejects %s without running target code', async (_label, mode) => {
    const { runner, sandbox } = setupFake(mode);

    await expect(runner.verify(runnerRequest())).rejects.toMatchObject({ code: 'runner-bootstrap-rejected' });
    expect(sandbox.commandArgv.some(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py')).toBe(false);
    expect(sandbox.commandArgv.some(argv => argv[2] === 'reset')).toBe(false);
  });

  it('cancels and destroys the sandbox if bootstrap output stalls', async () => {
    const { runner, sandbox } = setupFake('bootstrap-cancel');
    const started = new Promise<void>(resolve => { sandbox.bootstrapStarted = resolve; });
    const resultPromise = runner.verify(runnerRequest());
    await started;

    await runner.cancel('job-1');
    await expect(resultPromise).rejects.toMatchObject({ code: 'runner-cancelled' });
    expect(sandbox.commandArgv.some(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py')).toBe(false);
    expect(sandbox.commandArgv.some(argv => argv[2] === 'reset')).toBe(false);
    expect(sandbox.destroyCount).toBe(2);
  });

  it('bounds a stalled bootstrap process-start call by the remaining job deadline', async () => {
    const { runner, sandbox } = setupFake('bootstrap-stall-start');
    const startedAt = performance.now();

    await expect(runner.verify(runnerRequest({ maxJobSeconds: 0.03, remainingJobSeconds: 0.03 })))
      .rejects.toBeInstanceOf(SandboxRunnerError);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(sandbox.commandArgv.some(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py')).toBe(false);
    expect(sandbox.commandArgv.some(argv => argv[2] === 'reset')).toBe(false);
    expect(sandbox.destroyCount).toBeGreaterThanOrEqual(2);
  });

  it('materializes the complete pinned tree, including fixed tests/helpers, with no credentials or egress', async () => {
    const { runner, sandbox } = setupFake();
    const request = runnerRequest();
    const result = await runner.verify(request);

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ index: 0, exitCode: 0 });
    expect(result.workspaceFiles).toEqual([{
      path: 'lib/parser.ts', operation: 'write', mode: '100644', sha256: createHash('sha256').update(staged).digest('hex'),
    }]);
    expect(sandbox.files.get('tests/fixed.spec.ts')?.content).toBe(fixedTest);
    expect(sandbox.files.get('tests/helper.py')?.content).toBe(fixedHelper);
    expect(sandbox.startOptions).toEqual({ enableInternet: false });
    expect(request.verificationWorkspace.complete).toBe(true);
    expect(request.verificationWorkspace.files.map(item => item.path).sort()).toEqual(completeSnapshot.files.map(item => item.path).sort());
    expect(sandbox.commandEnvironments.every(environment =>
      !Object.keys(environment).some(key => /TOKEN|KEY|SECRET|PRIVATE/i.test(key)))).toBe(true);
    expect(sandbox.destroyCount).toBe(2); // discard stale job runtime, then clean this run
  });

  it('marks the trusted plan as unselected when no selection IDs are pinned', async () => {
    const { runner, sandbox } = setupFake();
    const request = runnerRequest({ plan: { ...plan, selectedSelectionIds: [] } });

    const result = await runner.verify(request);

    expect(result.status).toBe('passed');
    const testIndex = sandbox.commandArgv.findIndex(argv => argv[2] === '/opt/oc-port-agent/run-as-runner.py');
    expect(sandbox.commandEnvironments[testIndex]).toMatchObject({
      OC_PORT_UPSTREAM_COMMIT: plan.toCommit,
      OC_PORT_TARGET_COMMIT: plan.targetBaseCommit,
      OC_PORT_HAS_SELECTIONS: 'false',
    });
  });

  it('rejects command mutations to the complete tree, even when the command exits zero', async () => {
    const { runner } = setupFake('mutate');
    const result = await runner.verify(runnerRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('forbidden-mutation');
    expect(result.workspaceFiles.some(file => file.path === 'tests/generated.log')).toBe(true);
  });

  it('bounds command output and does not return raw output to the caller', async () => {
    const { runner } = setupFake('fail');
    const result = await runner.verify(runnerRequest({ maxOutputBytes: 256 }));
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('command-failed');
    expect(result.steps[0]).toMatchObject({ exitCode: 7, stdoutBytes: 21 });
    expect(JSON.stringify(result)).not.toContain('sensitive test output');
  });

  it('delivers bounded verification output only to an explicitly supplied trusted observer', async () => {
    const observations: unknown[] = [];
    const { runner } = setupFake('fail', 'job-1', observation => observations.push(observation));
    const result = await runner.verify(runnerRequest({ maxOutputBytes: 256 }));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      jobId: 'job-1',
      targetFullName: 'target-org/target',
      targetBaseCommit: targetCommit,
      verificationCount: 1,
      index: 0,
      command: 'npm',
      args: ['test'],
      exitCode: 7,
      timedOut: false,
      truncated: false,
      stdout: 'sensitive test output',
      stderr: '',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive test output');
  });

  it('fails closed and still cleans the sandbox when the trusted output observer throws', async () => {
    const { runner, sandbox } = setupFake('fail', 'job-1', () => { throw new Error('observer failure'); });
    const result = await runner.verify(runnerRequest({ maxOutputBytes: 256 }));

    expect(result).toMatchObject({ status: 'failed', failureCode: 'invalid-workspace' });
    expect(JSON.stringify(result)).not.toContain('sensitive test output');
    expect(sandbox.destroyCount).toBe(2);
  });

  it('reports remote process timeouts as non-retryable timeout evidence', async () => {
    const { runner } = setupFake('timeout');
    const result = await runner.verify(runnerRequest());
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('timed-out');
    expect(result.steps[0]?.exitCode).toBeNull();
  });

  it('cancels the running job-owned process and still cleans its sandbox', async () => {
    const { runner, sandbox } = setupFake('cancel');
    const started = new Promise<void>(resolve => { sandbox.commandStarted = resolve; });
    const resultPromise = runner.verify(runnerRequest());
    await started;
    await runner.cancel('job-1');
    const result = await resultPromise;
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('cancelled');
    expect(sandbox.destroyCount).toBe(2);
  });

  it.each([
    ['sandbox start RPC', 'stall-start'],
    ['helper process-start RPC', 'stall-helper-start'],
    ['verification process-start RPC', 'stall-command-start'],
  ] as const)('bounds a stalled %s and cleans the job sandbox', async (_name, mode) => {
    const { runner, sandbox } = setupFake(mode);
    const startedAt = performance.now();
    const result = runner.verify(runnerRequest({ maxJobSeconds: 0.03, remainingJobSeconds: 0.03 }));
    if (mode === 'stall-command-start') {
      const commandStarted = new Promise<void>(resolve => { sandbox.commandStarted = resolve; });
      await commandStarted;
    }
    if (mode === 'stall-command-start') {
      await expect(result).resolves.toMatchObject({ status: 'failed' });
    } else {
      await expect(result).rejects.toBeInstanceOf(SandboxRunnerError);
    }
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(sandbox.destroyCount).toBeGreaterThanOrEqual(2);
  });

  it('bounds a stalled process-kill RPC during active cancellation', async () => {
    const { runner, sandbox } = setupFake('stall-kill');
    const started = new Promise<void>(resolve => { sandbox.commandStarted = resolve; });
    const resultPromise = runner.verify(runnerRequest());
    await started;
    const startedAt = performance.now();
    await runner.cancel('job-1');
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    await expect(resultPromise).resolves.toMatchObject({ status: 'failed', failureCode: 'cancelled' });
    expect(sandbox.destroyCount).toBe(2);
  });

  it('fails closed on final destroy failure and permits a later job-owned cleanup retry', async () => {
    const { runner, sandbox } = setupFake();
    sandbox.destroyFailCalls.add(2); // stale-container reset succeeds; final teardown fails

    await expect(runner.verify(runnerRequest())).rejects.toMatchObject({
      code: 'runner-cleanup-failed',
    });
    expect(sandbox.destroyCount).toBe(2);
    await runner.cancel('job-1');
    expect(sandbox.destroyCount).toBe(3);
  });

  it('rejects an incomplete full-workspace contract before materialization', async () => {
    const { runner, sandbox } = setupFake();
    await expect(runner.verify(runnerRequest({
      verificationWorkspace: { ...verificationWorkspace, files: [] },
    }))).rejects.toMatchObject({ code: 'runner-incomplete-workspace-inventory' });
    expect(sandbox.destroyCount).toBe(2);
  });

  it('counts unique directories incrementally and rejects the first entry beyond its ceiling', async () => {
    const helper = fileURLToPath(new URL('../container/verify.py', import.meta.url));
    const script = String.raw`
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_gate", sys.argv[1])
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="ocpa-dir-unique-") as temporary:
    root = Path(temporary)
    (root / "d1" / "nested").mkdir(parents=True)
    (root / "d2").mkdir()
    files, directories = module.walk_workspace(
        root, max_files=10, max_directories=3, max_file_bytes=1024,
        max_total_bytes=4096, max_path_bytes=1024, max_depth=16,
    )
    assert files == []
    assert directories == ["d1", "d1/nested", "d2"]

with tempfile.TemporaryDirectory(prefix="ocpa-dir-overflow-") as temporary:
    root = Path(temporary)
    for index in range(100):
        (root / f"empty-{index:03d}").mkdir()
    original_scandir = module.os.scandir
    scanned = 0
    class CountingScandir:
        def __init__(self, path):
            self.iterator = original_scandir(path)
        def __iter__(self):
            return self
        def __next__(self):
            global scanned
            scanned += 1
            return next(self.iterator)
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            self.iterator.close()
    module.os.scandir = lambda path: CountingScandir(path)
    try:
        module.walk_workspace(
            root, max_files=10, max_directories=2, max_file_bytes=1024,
            max_total_bytes=4096, max_path_bytes=1024, max_depth=16,
        )
    except module.GateError:
        pass
    else:
        raise AssertionError("over-limit directories were accepted")
    assert scanned == 3, f"expected to stop at the first excess directory, scanned={scanned}"
`;
    const result = await execFileAsync('python3', ['-c', script, helper], { timeout: 15_000, maxBuffer: 1_000_000 });
    expect(result.stderr).toBe('');
  });

  it('feeds the independent inventory result through core policy gates before a job can be publishable', async () => {
    const policy = parsePolicy(rawCorePolicy());
    const digest = await policyHash(policy);
    const registration: TrackingRegistration = {
      id: 'tracking-1',
      installationId: 42,
      target: plan.target,
      baseBranch: 'main',
      upstream: { repository: plan.upstreamRepository, ref: 'main', baselineCommit: coreFromCommit },
      policy,
      policyHash: digest,
      lastCheckedCommit: coreFromCommit,
      lastSyncedCommit: coreFromCommit,
      active: true,
      revision: 1,
    };
    const store = new CoreStore(registration);
    const github = new CoreGitHub(corePlan());
    const { runner, sandbox } = setupFake('mutate', null);
    const agent = {
      run: async (_request: AgentRequest): Promise<AgentOutput> => ({
        report: {
          summary: 'Update the parser.',
          decisions: [{ selection: 'parser', status: 'applied', reason: 'The parser behavior changed.' }],
        },
        edits: [{ path: 'lib/parser.ts', operation: 'write', content: staged }],
        stepsUsed: 1,
        durationMs: 1,
      }),
    };
    const ports: CorePorts = { store, github, agent, runner };

    const result = await runJob(registration.id, ports);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.job.status).toBe('blocked');
      expect(result.job.failure?.code).toBe('forbidden-mutation');
    }
    expect([...store.jobs.values()].some(job => job.status === 'ready-to-publish')).toBe(false);
    expect(github.publishCalls).toBe(0);
    expect(sandbox.files.get('tests/generated.log')?.content).toBe('unapproved output\n');
  });

  it('counts unique directories once and stops scanning at the first over-limit entry', async () => {
    const helper = fileURLToPath(new URL('../container/verify.py', import.meta.url));
    const script = String.raw`
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_gate", sys.argv[1])
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="ocpa-dir-limit-") as temporary:
    root = Path(temporary)
    (root / "d1" / "nested").mkdir(parents=True)
    (root / "d2").mkdir()
    files, directories = module.walk_workspace(
        root, max_files=10, max_directories=3, max_file_bytes=1024,
        max_total_bytes=4096, max_path_bytes=1024, max_depth=16,
    )
    assert files == []
    assert directories == ["d1", "d1/nested", "d2"]

with tempfile.TemporaryDirectory(prefix="ocpa-dir-overflow-") as temporary:
    root = Path(temporary)
    for index in range(100):
        (root / f"empty-{index:03d}").mkdir()
    original_scandir = module.os.scandir
    scanned = 0
    class CountingScandir:
        def __init__(self, path):
            self.iterator = original_scandir(path)
        def __iter__(self):
            return self
        def __next__(self):
            global scanned
            scanned += 1
            return next(self.iterator)
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            self.iterator.close()
    module.os.scandir = lambda path: CountingScandir(path)
    try:
        module.walk_workspace(
            root, max_files=10, max_directories=2, max_file_bytes=1024,
            max_total_bytes=4096, max_path_bytes=1024, max_depth=16,
        )
    except module.GateError:
        pass
    else:
        raise AssertionError("over-limit directories were accepted")
    assert scanned == 3, f"expected to stop at the first excess directory, scanned={scanned}"
`;
    const result = await execFileAsync('python3', ['-c', script, helper], { timeout: 15_000, maxBuffer: 1_000_000 });
    expect(result.stderr).toBe('');
  });
});
