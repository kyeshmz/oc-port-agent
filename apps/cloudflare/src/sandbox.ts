import type { ProcessOutput, ProcessTextOutputOptions, Sandbox, SandboxEnv } from '@cloudflare/sandbox';
import { DEFAULT_VERIFICATION_WORKSPACE_LIMITS } from './contracts.js';
import type {
  RunnerPort,
  RunnerRequest,
  SnapshotFile,
  TargetSnapshot,
  VerificationWorkspaceLimits,
  VerificationWorkspaceSnapshot,
  VerificationResult,
  VerificationStepResult,
  WorkspaceFileEvidence,
} from './contracts.js';
import { INTERNAL_PATHS, DEFAULT_PROTECTED_PATHS, SENSITIVE_PATHS, matchesAny, safePath } from './policy.js';
import {
  isVerifiedSandboxBootstrapOutput,
  makeSandboxBootstrapCommand,
  SANDBOX_RUNNER_LAUNCHER_PATH,
  SANDBOX_VERIFIER_PATH,
} from './sandbox-bootstrap.js';

export { sandboxVerifierBootstrapMetadata } from './sandbox-bootstrap.js';
export type { SandboxVerifierBootstrapStatus } from './sandbox-bootstrap.js';

const WORKSPACE_ROOT = '/workspace/ocpa-job';
const VERIFY_SCRIPT = SANDBOX_VERIFIER_PATH;
const HELPER_TIMEOUT_MS = 15_000;
const BOOTSTRAP_OUTPUT_BYTES = 16_384;
const CANCEL_LOOKUP_TIMEOUT_MS = 2_000;
const MAX_FILES = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxFiles;
const MAX_DIRECTORIES = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxDirectories;
const MAX_FILE_BYTES = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxFileBytes;
const MAX_WORKSPACE_BYTES = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxBytes;
const MAX_PATH_BYTES = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxPathBytes;
const MAX_PATH_DEPTH = DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxPathDepth;
const MAX_INVENTORY_BYTES = 5_000_000;
const RUNNER_ENV: Readonly<Record<string, string>> = Object.freeze({
  CI: '1',
  HOME: '/tmp/ocpa-home',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONPYCACHEPREFIX: '/tmp/ocpa-pycache',
});

export type SandboxNamespace = SandboxEnv['Sandbox'];

export interface RunnerSandbox {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  start(options?: { enableInternet?: boolean }): Promise<void>;
  exec(command: readonly [string, ...string[]], options: {
    cwd: string;
    env: Record<string, string>;
    timeout: number;
  }): Promise<RunnerProcess>;
  destroy(): Promise<void>;
}

interface RunnerProcess {
  id: string;
  output(options: ProcessTextOutputOptions): Promise<ProcessOutput<string>>;
  kill(signal?: number): Promise<void>;
}

export interface SandboxRunnerOptions {
  namespace?: SandboxNamespace;
  /** Test-only process boundary; production uses the installed preview SDK adapter. */
  sandboxForId?: (id: string) => RunnerSandbox;
  limits?: Partial<VerificationWorkspaceLimits>;
  destroyTimeoutMs?: number;
  /** Trusted in-process observer; receives bounded step output but must not log or forward it. */
  observeVerificationOutput?: (observation: VerificationOutputObservation) => void;
}

export interface VerificationOutputObservation {
  jobId: string;
  targetFullName: string;
  targetBaseCommit: string;
  verificationCount: number;
  index: number;
  command: string;
  args: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

export class SandboxRunnerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SandboxRunnerError';
    this.code = code;
  }
}

async function sandboxForId(options: SandboxRunnerOptions, id: string): Promise<RunnerSandbox> {
  if (options.sandboxForId) return options.sandboxForId(id);
  const namespace = options.namespace;
  if (!namespace) throw new SandboxRunnerError('sandbox-binding-missing');
  const sdk = await import('@cloudflare/sandbox');
  return sdk.getSandbox(namespace, id, { normalizeId: true, keepAlive: false, sleepAfter: 7_200 });
}

interface InventoryFile {
  path: string;
  sha256: string;
  mode: '100644' | '100755';
  sizeBytes: number;
}

interface Inventory {
  files: InventoryFile[];
  directories: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verificationPlanEnvironment(plan: RunnerRequest['plan']): Readonly<Record<string, string>> {
  if (!isRecord(plan) || typeof plan.toCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(plan.toCommit)
    || typeof plan.targetBaseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(plan.targetBaseCommit)
    || !Array.isArray(plan.selectedSelectionIds) || plan.selectedSelectionIds.some(id => typeof id !== 'string')) {
    throw new SandboxRunnerError('runner-plan-pin-invalid');
  }
  return Object.freeze({
    OC_PORT_UPSTREAM_COMMIT: plan.toCommit,
    OC_PORT_TARGET_COMMIT: plan.targetBaseCommit,
    OC_PORT_HAS_SELECTIONS: plan.selectedSelectionIds.length > 0 ? 'true' : 'false',
  });
}

interface ActiveRun {
  sandbox: RunnerSandbox | undefined;
  sandboxReady?: Promise<RunnerSandbox>;
  controller: AbortController;
  process: RunnerProcess | undefined;
  destroyPromise?: Promise<void>;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function invalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function assertSnapshot(
  request: RunnerRequest,
  snapshot: VerificationWorkspaceSnapshot,
  limits: VerificationWorkspaceLimits,
): VerificationWorkspaceSnapshot {
  if (!snapshot || snapshot.complete !== true
    || snapshot.repository.fullName.toLowerCase() !== request.plan.target.fullName.toLowerCase()
    || snapshot.repository.owner.toLowerCase() !== request.plan.target.owner.toLowerCase()
    || snapshot.repository.name.toLowerCase() !== request.plan.target.name.toLowerCase()
    || snapshot.baseBranch !== request.plan.baseBranch || snapshot.commit !== request.plan.targetBaseCommit) {
    throw new SandboxRunnerError('runner-snapshot-mismatch');
  }
  if (snapshot.files.length > limits.maxFiles || snapshot.existingPaths.length > limits.maxFiles) {
    throw new SandboxRunnerError('runner-workspace-file-limit');
  }

  const expected = new Set<string>();
  const directories = new Set<string>();
  for (const path of snapshot.existingPaths) {
    if (!safePath(path) || utf8Bytes(path) > limits.maxPathBytes || path.split('/').length > limits.maxPathDepth
      || matchesAny(path, [...INTERNAL_PATHS, ...DEFAULT_PROTECTED_PATHS, ...SENSITIVE_PATHS])
      || expected.has(path)) {
      throw new SandboxRunnerError('runner-invalid-workspace-path');
    }
    expected.add(path);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
      if (directories.size > limits.maxDirectories) throw new SandboxRunnerError('runner-workspace-directory-limit');
    }
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const files: SnapshotFile[] = [];
  for (const file of snapshot.files) {
    if (!expected.has(file.path) || seen.has(file.path) || !safePath(file.path)
      || (file.mode !== '100644' && file.mode !== '100755') || file.content.includes('\0')
      || invalidUnicode(file.content) || utf8Bytes(file.path) > limits.maxPathBytes
      || file.path.split('/').length > limits.maxPathDepth) {
      throw new SandboxRunnerError('runner-invalid-workspace-file');
    }
    const sizeBytes = utf8Bytes(file.content);
    if (sizeBytes !== file.sizeBytes || sizeBytes > limits.maxFileBytes) {
      throw new SandboxRunnerError('runner-workspace-file-limit');
    }
    totalBytes += sizeBytes;
    if (totalBytes > limits.maxBytes) throw new SandboxRunnerError('runner-workspace-byte-limit');
    seen.add(file.path);
    files.push({ path: file.path, content: file.content, sizeBytes, mode: file.mode });
  }
  if (seen.size !== expected.size || [...expected].some(path => !seen.has(path))) {
    throw new SandboxRunnerError('runner-incomplete-workspace-inventory');
  }

  for (const path of expected) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join('/');
      if (expected.has(ancestor)) throw new SandboxRunnerError('runner-file-directory-collision');
    }
  }

  const completeFiles = new Map(snapshot.files.map(file => [file.path, file]));
  for (const pinned of request.target.files) {
    const complete = completeFiles.get(pinned.path);
    if (!complete || complete.content !== pinned.content || complete.mode !== pinned.mode) {
      throw new SandboxRunnerError('runner-scoped-snapshot-not-in-complete-target');
    }
  }
  for (const path of request.target.existingPaths) {
    if (!expected.has(path)) throw new SandboxRunnerError('runner-scoped-inventory-not-in-complete-target');
  }

  const normalized: VerificationWorkspaceSnapshot = {
    complete: true,
    repository: snapshot.repository,
    baseBranch: snapshot.baseBranch,
    commit: snapshot.commit,
    existingPaths: [...expected],
    files,
  };
  if (utf8Bytes(JSON.stringify(normalized)) > limits.maxSerializedBytes) {
    throw new SandboxRunnerError('runner-workspace-serialized-limit');
  }
  return normalized;
}

function effectiveFiles(
  snapshot: TargetSnapshot,
  request: RunnerRequest,
  limits: VerificationWorkspaceLimits,
): Map<string, InventoryFile> {
  const files = new Map(snapshot.files.map(file => [file.path, {
    path: file.path,
    sha256: '',
    mode: file.mode,
    sizeBytes: file.sizeBytes,
  }]));
  const edited = new Set<string>();
  for (const edit of request.edits) {
    if (!safePath(edit.path) || edited.has(edit.path)
      || matchesAny(edit.path, [...INTERNAL_PATHS, ...DEFAULT_PROTECTED_PATHS, ...SENSITIVE_PATHS])) {
      throw new SandboxRunnerError('runner-staged-edit-unsafe');
    }
    edited.add(edit.path);
    if (edit.operation === 'delete') {
      if (!files.has(edit.path)) throw new SandboxRunnerError('runner-delete-missing-file');
      files.delete(edit.path);
      continue;
    }
    if (typeof edit.content !== 'string' || edit.content.includes('\0') || invalidUnicode(edit.content)) {
      throw new SandboxRunnerError('runner-staged-edit-not-text');
    }
    const sizeBytes = utf8Bytes(edit.content);
    if (sizeBytes > limits.maxFileBytes) throw new SandboxRunnerError('runner-staged-edit-too-large');
    const mode = files.get(edit.path)?.mode ?? '100644';
    files.set(edit.path, { path: edit.path, sha256: '', mode, sizeBytes });
  }
  if (files.size > limits.maxFiles) throw new SandboxRunnerError('runner-workspace-file-limit');
  return files;
}

function expectedDirectories(files: ReadonlyMap<string, InventoryFile>): string[] {
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      if (directories.has(directory)) continue;
      if (directories.size >= MAX_DIRECTORIES) throw new SandboxRunnerError('runner-workspace-directory-limit');
      directories.add(directory);
    }
  }
  return [...directories].sort();
}

function parseInventory(value: unknown): Inventory {
  if (!isRecord(value)) throw new SandboxRunnerError('runner-inventory-invalid');
  const raw = value;
  if (Object.keys(raw).some(key => key !== 'files' && key !== 'directories')
    || !Array.isArray(raw.files) || !Array.isArray(raw.directories)
    || raw.files.length > MAX_FILES || raw.directories.length > MAX_DIRECTORIES) {
    throw new SandboxRunnerError('runner-inventory-invalid');
  }
  const seen = new Set<string>();
  const files: InventoryFile[] = [];
  for (const candidate of raw.files) {
    if (!isRecord(candidate)) throw new SandboxRunnerError('runner-inventory-invalid');
    const item = candidate;
    if (Object.keys(item).some(key => !['path', 'sha256', 'mode', 'sizeBytes'].includes(key))
      || typeof item.path !== 'string' || !safePath(item.path) || seen.has(item.path)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || (item.mode !== '100644' && item.mode !== '100755')
      || typeof item.sizeBytes !== 'number' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || item.sizeBytes > MAX_FILE_BYTES) {
      throw new SandboxRunnerError('runner-inventory-invalid');
    }
    seen.add(item.path);
    files.push({ path: item.path, sha256: item.sha256, mode: item.mode, sizeBytes: item.sizeBytes });
  }
  const directories: string[] = [];
  const directorySet = new Set<string>();
  for (const directory of raw.directories) {
    if (typeof directory !== 'string' || !safePath(directory) || directorySet.has(directory)) {
      throw new SandboxRunnerError('runner-inventory-invalid');
    }
    directorySet.add(directory);
    directories.push(directory);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort();
  return { files, directories };
}

function expectedInventory(files: Map<string, InventoryFile>): Inventory {
  return {
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    directories: expectedDirectories(files),
  };
}

function inventoryMatches(actual: Inventory, expected: Inventory): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function workspaceEvidence(inventory: Inventory, edits: RunnerRequest['edits']): WorkspaceFileEvidence[] {
  const current = new Map(inventory.files.map(file => [file.path, file]));
  const evidence: WorkspaceFileEvidence[] = [];
  for (const edit of edits) {
    const file = current.get(edit.path);
    if (edit.operation === 'write') {
      if (file) evidence.push({ path: edit.path, operation: 'write', sha256: file.sha256, mode: file.mode });
      else evidence.push({ path: edit.path, operation: 'delete' });
    } else if (file) {
      evidence.push({ path: edit.path, operation: 'write', sha256: file.sha256, mode: file.mode });
    } else {
      evidence.push({ path: edit.path, operation: 'delete' });
    }
  }
  return evidence.sort((left, right) => left.path.localeCompare(right.path));
}

function makeInventoryCommand(): readonly [string, ...string[]] {
  return [
    'python3', VERIFY_SCRIPT, 'inventory', '--root', WORKSPACE_ROOT,
    '--max-files', String(MAX_FILES), '--max-file-bytes', String(MAX_FILE_BYTES),
    '--max-total-bytes', String(MAX_WORKSPACE_BYTES), '--max-path-bytes', String(MAX_PATH_BYTES),
    '--max-depth', String(MAX_PATH_DEPTH), '--max-directories', String(MAX_DIRECTORIES),
  ];
}

function makePrepareCommand(): readonly [string, ...string[]] {
  return [
    'python3', VERIFY_SCRIPT, 'prepare', '--root', WORKSPACE_ROOT,
    '--manifest', '/tmp/ocpa-job-modes.json', '--runner-user', 'runner',
  ];
}

async function boundedDestroy(sandbox: RunnerSandbox, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sandbox.destroy(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new SandboxRunnerError('runner-cleanup-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function destroyActiveSandbox(run: ActiveRun, sandbox: RunnerSandbox, timeoutMs: number): Promise<void> {
  run.destroyPromise ??= boundedDestroy(sandbox, timeoutMs);
  return run.destroyPromise;
}

async function boundedSandboxLookup(options: SandboxRunnerOptions, id: string, timeoutMs: number): Promise<RunnerSandbox> {
  let timedOut = false;
  const lookup = sandboxForId(options, id);
  void lookup.then(sandbox => {
    if (timedOut) void boundedDestroy(sandbox, 2_000).catch(() => undefined);
  }).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new SandboxRunnerError('runner-sandbox-start-timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedSandboxLookupResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SandboxRunnerError('runner-sandbox-start-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedKill(process: RunnerProcess, timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      process.kill(9),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SandboxRunnerError('runner-kill-timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withinJobBudget<T>(
  run: ActiveRun,
  promise: Promise<T>,
  deadline: number,
  abortRunOnTimeout = true,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new SandboxRunnerError('runner-time-budget-exhausted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SandboxRunnerError('runner-cancelled'));
    if (run.controller.signal.aborted) onAbort();
    else run.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (run.process) void boundedKill(run.process);
      if (run.sandbox) void destroyActiveSandbox(run, run.sandbox, 2_000).catch(() => undefined);
      if (abortRunOnTimeout) run.controller.abort();
      reject(new SandboxRunnerError(abortRunOnTimeout ? 'runner-time-budget-exhausted' : 'runner-command-timeout'));
    }, remaining);
  });
  try {
    return await Promise.race([promise, aborted, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) run.controller.signal.removeEventListener('abort', onAbort);
  }
}

class CloudflareSandboxRunner implements RunnerPort {
  private readonly active = new Map<string, ActiveRun>();
  private readonly limits: VerificationWorkspaceLimits;

  constructor(private readonly options: SandboxRunnerOptions) {
    this.limits = {
      ...DEFAULT_VERIFICATION_WORKSPACE_LIMITS,
      ...options.limits,
    };
  }

  async verify(request: RunnerRequest): Promise<VerificationResult> {
    const planEnvironment = verificationPlanEnvironment(request.plan);
    if (this.active.has(request.jobId)) throw new SandboxRunnerError('runner-job-already-active');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.jobId)) throw new SandboxRunnerError('runner-job-id-invalid');
    const sandboxId = `ocpa-verify-${request.jobId.toLowerCase()}`;
    const run: ActiveRun = { sandbox: undefined, controller: new AbortController(), process: undefined };
    this.active.set(request.jobId, run);
    const startedAt = performance.now();
    const deadline = startedAt + Math.max(1, Math.min(request.maxJobSeconds, request.remainingJobSeconds) * 1_000);
    let result: VerificationResult | undefined;
    let cleanupError: unknown;
    let sandbox: RunnerSandbox | undefined;

    try {
      const sandboxPromise = sandboxForId(this.options, sandboxId);
      run.sandboxReady = sandboxPromise;
      void sandboxPromise.then(candidate => {
        if (run.controller.signal.aborted) {
          run.sandbox = candidate;
          void destroyActiveSandbox(run, candidate, 2_000).catch(() => undefined);
        }
      }).catch(() => undefined);
      sandbox = await withinJobBudget(run, sandboxPromise, deadline);
      run.sandbox = sandbox;
      // A deterministic per-job sandbox can outlive this DO isolate. Destroy
      // only that job-owned instance before reusing its identity, then start it
      // explicitly with outbound Internet disabled.
      try {
        await boundedDestroy(sandbox, Math.max(1, Math.min(
          this.options.destroyTimeoutMs ?? 10_000,
          deadline - performance.now(),
        )));
      } catch {
        throw new SandboxRunnerError('runner-stale-sandbox-reset-failed');
      }
      if (run.controller.signal.aborted) throw new SandboxRunnerError('runner-cancelled');
      const snapshot = assertSnapshot(request, request.verificationWorkspace, this.limits);
      const files = effectiveFiles(snapshot, request, this.limits);
      const totalBytes = [...files.values()].reduce((sum, file) => sum + file.sizeBytes, 0);
      if (totalBytes > this.limits.maxBytes) throw new SandboxRunnerError('runner-workspace-byte-limit');

      await withinJobBudget(run, sandbox.start({ enableInternet: false }), deadline);
      await this.ensureTrustedBootstrap(run, deadline);
      await withinJobBudget(run, sandbox.mkdir('/workspace', { recursive: true }), deadline);
      await this.runHelper(run, makeResetCommand(), deadline, HELPER_TIMEOUT_MS, 64_000);

      const byPath = new Map(snapshot.files.map(file => [file.path, file]));
      for (const edit of request.edits) {
        if (edit.operation === 'delete') byPath.delete(edit.path);
        else {
          const old = byPath.get(edit.path);
          byPath.set(edit.path, {
            path: edit.path,
            content: edit.content!,
            sizeBytes: utf8Bytes(edit.content!),
            mode: old?.mode ?? '100644',
          });
        }
      }

      for (const file of byPath.values()) {
        const absolute = `${WORKSPACE_ROOT}/${file.path}`;
        const parent = absolute.slice(0, absolute.lastIndexOf('/'));
        await withinJobBudget(run, sandbox.mkdir(parent, { recursive: true }), deadline);
        await withinJobBudget(run, sandbox.writeFile(absolute, file.content), deadline);
      }
      const modeManifest = JSON.stringify([...byPath.values()].map(file => ({ path: file.path, mode: file.mode })));
      await withinJobBudget(run, sandbox.writeFile('/tmp/ocpa-job-modes.json', modeManifest), deadline);
      await this.runHelper(run, makePrepareCommand(), deadline, HELPER_TIMEOUT_MS, 64_000);

      const expectedFiles = new Map<string, InventoryFile>();
      for (const file of byPath.values()) {
        expectedFiles.set(file.path, {
          path: file.path,
          sha256: await sha256Text(file.content),
          mode: file.mode,
          sizeBytes: utf8Bytes(file.content),
        });
      }
      const expected = expectedInventory(expectedFiles);
      const before = await this.readInventory(run, deadline);
      if (!inventoryMatches(before, expected)) throw new SandboxRunnerError('runner-materialization-mismatch');

      const steps: VerificationStepResult[] = [];
      let outputBytes = 0;
      let failureCode: VerificationResult['failureCode'];
      for (let index = 0; index < request.verification.length; index++) {
        if (run.controller.signal.aborted) {
          failureCode = 'cancelled';
          break;
        }
        const command = request.verification[index]!;
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          steps.push({ index, exitCode: null, durationMs: 0, stdoutBytes: 0, stderrBytes: 0 });
          failureCode = 'timed-out';
          break;
        }
        const timeoutMs = Math.max(1, Math.min(command.timeoutSeconds * 1_000, remainingMs));
        const argv = [
          'python3', '-I', SANDBOX_RUNNER_LAUNCHER_PATH,
          command.command, ...command.args,
        ] as const;
        const stepStartedAt = performance.now();
        let process: RunnerProcess | undefined;
        try {
          const processPromise = sandbox.exec(argv, {
            cwd: WORKSPACE_ROOT,
            env: { ...RUNNER_ENV, ...planEnvironment },
            timeout: timeoutMs,
          });
          void processPromise.then(lateProcess => {
            if (run.controller.signal.aborted) void boundedKill(lateProcess);
          }).catch(() => undefined);
          process = await withinJobBudget(
            run,
            processPromise,
            Math.min(deadline, stepStartedAt + timeoutMs),
            deadline <= stepStartedAt + timeoutMs,
          );
          run.process = process;
          const availableOutput = Math.max(1, request.maxOutputBytes - outputBytes);
          let output: ProcessOutput<string>;
          try {
          output = await withinJobBudget(run, process.output({
              encoding: 'utf8',
              maxBytes: availableOutput,
              timeout: timeoutMs,
              signal: run.controller.signal,
          }), Math.min(deadline, stepStartedAt + timeoutMs), deadline <= stepStartedAt + timeoutMs);
          } catch (error) {
            await boundedKill(process);
            if (run.controller.signal.aborted) throw error;
            if (error instanceof SandboxRunnerError && error.code === 'runner-time-budget-exhausted') {
              throw new SandboxRunnerError('runner-command-timeout');
            }
            throw error;
          }
          if (run.controller.signal.aborted) {
            run.process = undefined;
            steps.push({
              index,
              exitCode: null,
              durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
              stdoutBytes: 0,
              stderrBytes: 0,
            });
            failureCode = 'cancelled';
            break;
          }
          const stdoutBytes = utf8Bytes(output.stdout);
          const stderrBytes = utf8Bytes(output.stderr);
          outputBytes += stdoutBytes + stderrBytes;
          const durationMs = Math.max(0, Math.round(performance.now() - stepStartedAt));
          let observerFailed = false;
          try {
            this.options.observeVerificationOutput?.({
              jobId: request.jobId,
              targetFullName: request.plan.target.fullName,
              targetBaseCommit: request.plan.targetBaseCommit,
              verificationCount: request.verification.length,
              index,
              command: command.command,
              args: command.args,
              exitCode: output.timedOut ? null : output.exitCode,
              timedOut: output.timedOut,
              truncated: output.truncated,
              stdout: output.stdout,
              stderr: output.stderr,
            });
          } catch {
            observerFailed = true;
          }
          steps.push({
            index,
            exitCode: output.timedOut ? null : output.exitCode,
            durationMs,
            stdoutBytes,
            stderrBytes,
          });
          run.process = undefined;
          if (observerFailed) {
            failureCode = 'invalid-workspace';
            break;
          }
          if (output.timedOut) {
            failureCode = 'timed-out';
            break;
          }
          if (output.truncated || outputBytes > request.maxOutputBytes) {
            failureCode = 'output-limit';
            break;
          }
          if (output.exitCode !== 0) {
            failureCode = 'command-failed';
            break;
          }
        } catch (error) {
          if (process) await boundedKill(process);
          run.process = undefined;
          const durationMs = Math.max(0, Math.round(performance.now() - stepStartedAt));
          const errorCode = error instanceof SandboxRunnerError ? error.code : '';
          if (run.controller.signal.aborted && errorCode === 'runner-cancelled') {
            steps.push({ index, exitCode: null, durationMs, stdoutBytes: 0, stderrBytes: 0 });
            failureCode = 'cancelled';
            break;
          }
          if (error instanceof SandboxRunnerError
            ? error.code === 'runner-command-timeout' || error.code === 'runner-time-budget-exhausted'
            : error instanceof Error && /timeout/i.test(error.name + error.message)) {
            steps.push({ index, exitCode: null, durationMs, stdoutBytes: 0, stderrBytes: 0 });
            failureCode = 'timed-out';
            break;
          }
          if (run.controller.signal.aborted) {
            steps.push({ index, exitCode: null, durationMs, stdoutBytes: 0, stderrBytes: 0 });
            failureCode = 'cancelled';
            break;
          }
          throw new SandboxRunnerError('runner-command-execution-failed');
        }
      }

      if (failureCode && steps.length === 0) {
        steps.push({ index: 0, exitCode: null, durationMs: 0, stdoutBytes: 0, stderrBytes: 0 });
      }

      let after = before;
      if (steps.length > 0) {
        try {
          after = await this.readInventory(
            run,
            deadline,
            run.controller.signal.aborted ? new AbortController().signal : run.controller.signal,
          );
        } catch {
          // An invalid or unreadable post-test tree is never publishable. The
          // core rechecks the staged-file evidence, while this code marks the
          // failure non-retryable and discards the sandbox in finally.
          failureCode = 'invalid-workspace';
        }
      }
      if (!inventoryMatches(after, expected)) {
        failureCode = 'forbidden-mutation';
        result = {
          status: 'failed',
          steps,
          workspaceFiles: this.mutationEvidence(before, after, request),
          failureCode,
        };
      } else if (failureCode) {
        result = { status: 'failed', steps, workspaceFiles: workspaceEvidence(after, request.edits), failureCode };
      } else {
        result = {
          status: 'passed',
          steps,
          workspaceFiles: workspaceEvidence(after, request.edits),
        };
      }
      return result;
    } finally {
      this.active.delete(request.jobId);
      if (sandbox) {
        try {
          await destroyActiveSandbox(run, sandbox, this.options.destroyTimeoutMs ?? 10_000);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) throw new SandboxRunnerError('runner-cleanup-failed');
    }
  }

  async cancel(jobId: string): Promise<void> {
    const run = this.active.get(jobId);
    if (run) {
      run.controller.abort();
      if (run.process) await boundedKill(run.process);
      let sandbox = run.sandbox;
      if (!sandbox && run.sandboxReady) {
        try {
          sandbox = await boundedSandboxLookupResult(run.sandboxReady, CANCEL_LOOKUP_TIMEOUT_MS);
        } catch {
          throw new SandboxRunnerError('runner-cleanup-pending');
        }
        run.sandbox = sandbox;
      }
      if (sandbox) {
        try {
          await destroyActiveSandbox(run, sandbox, this.options.destroyTimeoutMs ?? 10_000);
        } catch {
          throw new SandboxRunnerError('runner-cleanup-failed');
        }
      }
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(jobId)) throw new SandboxRunnerError('runner-job-id-invalid');
    const sandbox = await boundedSandboxLookup(
      this.options,
      `ocpa-verify-${jobId.toLowerCase()}`,
      this.options.destroyTimeoutMs ?? 10_000,
    );
    try {
      await boundedDestroy(sandbox, this.options.destroyTimeoutMs ?? 10_000);
    } catch {
      throw new SandboxRunnerError('runner-cleanup-failed');
    }
  }

  private async ensureTrustedBootstrap(run: ActiveRun, deadline: number): Promise<void> {
    const sandbox = run.sandbox;
    if (!sandbox) throw new SandboxRunnerError('runner-sandbox-unavailable');
    const remaining = deadline - performance.now();
    if (remaining <= 0 || run.controller.signal.aborted) {
      throw new SandboxRunnerError(run.controller.signal.aborted ? 'runner-cancelled' : 'runner-time-budget-exhausted');
    }
    const timeoutMs = Math.max(1, Math.min(HELPER_TIMEOUT_MS, remaining));
    const startedAt = performance.now();
    const processPromise = sandbox.exec(makeSandboxBootstrapCommand(), {
      cwd: '/tmp',
      env: { ...RUNNER_ENV },
      timeout: timeoutMs,
    });
    void processPromise.then(lateProcess => {
      if (run.controller.signal.aborted) void boundedKill(lateProcess);
    }).catch(() => undefined);

    let process: RunnerProcess;
    try {
      process = await withinJobBudget(run, processPromise, Math.min(deadline, startedAt + timeoutMs));
    } catch (error) {
      if (error instanceof SandboxRunnerError) throw error;
      if (run.controller.signal.aborted) throw new SandboxRunnerError('runner-cancelled');
      throw new SandboxRunnerError('runner-bootstrap-failed');
    }
    run.process = process;
    try {
      const output = await withinJobBudget(run, process.output({
        encoding: 'utf8',
        maxBytes: BOOTSTRAP_OUTPUT_BYTES,
        timeout: Math.max(1, Math.min(timeoutMs, deadline - performance.now())),
        signal: run.controller.signal,
      }), Math.min(deadline, performance.now() + timeoutMs));
      run.process = undefined;
      if (run.controller.signal.aborted) throw new SandboxRunnerError('runner-cancelled');
      if (output.exitCode !== 0 || output.timedOut || output.truncated || output.stderr !== ''
        || !isVerifiedSandboxBootstrapOutput(output.stdout)) {
        throw new SandboxRunnerError('runner-bootstrap-rejected');
      }
    } catch (error) {
      await boundedKill(process);
      run.process = undefined;
      if (error instanceof SandboxRunnerError) throw error;
      if (run.controller.signal.aborted) throw new SandboxRunnerError('runner-cancelled');
      throw new SandboxRunnerError('runner-bootstrap-failed');
    }
  }

  private async runHelper(
    run: ActiveRun,
    argv: readonly [string, ...string[]],
    deadline: number,
    helperTimeout: number,
    maxBytes: number,
    signal: AbortSignal = run.controller.signal,
  ): Promise<string> {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || signal.aborted) throw new SandboxRunnerError('runner-time-budget-exhausted');
    const sandbox = run.sandbox;
    if (!sandbox) throw new SandboxRunnerError('runner-sandbox-unavailable');
    const processPromise = sandbox.exec(argv, {
      cwd: '/workspace',
      env: { ...RUNNER_ENV },
      timeout: Math.max(1, Math.min(helperTimeout, remaining)),
    });
    void processPromise.then(lateProcess => {
      if (run.controller.signal.aborted) void boundedKill(lateProcess);
    }).catch(() => undefined);
    const process = await withinJobBudget(run, processPromise, Math.min(deadline, performance.now() + helperTimeout));
    run.process = process;
    try {
      const result = await withinJobBudget(run, process.output({
        encoding: 'utf8',
        maxBytes,
        timeout: Math.max(1, Math.min(helperTimeout, deadline - performance.now())),
        signal,
      }), Math.min(deadline, performance.now() + helperTimeout));
      run.process = undefined;
      if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new SandboxRunnerError('runner-helper-failed');
      return result.stdout;
    } catch (error) {
      await boundedKill(process);
      run.process = undefined;
      throw error instanceof SandboxRunnerError ? error : new SandboxRunnerError('runner-helper-failed');
    }
  }

  private async readInventory(run: ActiveRun, deadline: number, signal?: AbortSignal): Promise<Inventory> {
    const output = await this.runHelper(run, makeInventoryCommand(), deadline, HELPER_TIMEOUT_MS, MAX_INVENTORY_BYTES, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new SandboxRunnerError('runner-inventory-invalid');
    }
    return parseInventory(parsed);
  }

  private mutationEvidence(before: Inventory, after: Inventory, request: RunnerRequest): WorkspaceFileEvidence[] {
    const baseline = new Map(before.files.map(file => [file.path, file]));
    const current = new Map(after.files.map(file => [file.path, file]));
    const expectedEdits = new Map(request.edits.map(edit => [edit.path, edit]));
    const evidence: WorkspaceFileEvidence[] = [];
    for (const [path, original] of baseline) {
      const currentFile = current.get(path);
      if (!currentFile) {
        evidence.push({ path, operation: 'delete' });
      } else if (original.sha256 !== currentFile.sha256 || original.mode !== currentFile.mode) {
        evidence.push({ path, operation: 'write', sha256: currentFile.sha256, mode: currentFile.mode });
      }
    }
    for (const [path, file] of current) {
      if (!baseline.has(path)) evidence.push({ path, operation: 'write', sha256: file.sha256, mode: file.mode });
    }
    for (const edit of request.edits) {
      if (expectedEdits.get(edit.path)?.operation === 'delete' && current.has(edit.path)) {
        evidence.push({ path: edit.path, operation: 'write', sha256: current.get(edit.path)!.sha256, mode: current.get(edit.path)!.mode });
      }
    }
    return evidence.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function makeResetCommand(): readonly [string, ...string[]] {
  return ['python3', VERIFY_SCRIPT, 'reset', '--root', WORKSPACE_ROOT];
}

export function createSandboxRunner(options: SandboxRunnerOptions): RunnerPort & { cancel(jobId: string): Promise<void> } {
  return new CloudflareSandboxRunner(options);
}

export const sandboxWorkspaceLimits = Object.freeze({
  maxFiles: MAX_FILES,
  maxDirectories: MAX_DIRECTORIES,
  maxFileBytes: MAX_FILE_BYTES,
  maxBytes: MAX_WORKSPACE_BYTES,
  maxPathBytes: MAX_PATH_BYTES,
  maxPathDepth: MAX_PATH_DEPTH,
  maxSerializedBytes: DEFAULT_VERIFICATION_WORKSPACE_LIMITS.maxSerializedBytes,
});
