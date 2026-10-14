import { DEFAULT_VERIFICATION_WORKSPACE_LIMITS } from './contracts.js';
import type {
  AgentOutput,
  AgentRequest,
  AgentReport,
  CheckpointCandidate,
  CorePorts,
  DiscoveredPlan,
  JobProposal,
  JobRecord,
  JobRunResult,
  NewJobRecord,
  PinnedPlan,
  RepositoryIdentity,
  RunnerRequest,
  SnapshotFile,
  SourceSnapshot,
  StagedFileEdit,
  TargetSnapshot,
  TrackingRegistration,
  VerificationFailureCode,
  VerificationResult,
  VerificationStepResult,
  VerificationWorkspaceLimits,
  VerificationWorkspaceSnapshot,
  VerifiedJobProposal,
  VerifiedMergeObservation,
  WorkspaceFileEvidence,
} from './contracts.js';
import {
  PolicyValidationError,
  createGlobWorkBudget,
  excludedPathPatterns,
  filterChangedPaths,
  isProtectedOrSensitive,
  matchesAny,
  parsePolicy,
  policyHash,
  safePath,
  type GlobWorkBudget,
  type CloudflarePolicy,
} from './policy.js';

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const EDIT_OPERATIONS = ['write', 'delete'] as const;
const MAX_INFERENCE_GENERATIONS_PER_SYNC_ORIGIN = 2;
const MAX_SYNC_ORIGIN_JOBS_TO_SCAN = 32;
const VERIFICATION_CODES: readonly VerificationFailureCode[] = [
  'command-failed', 'timed-out', 'output-limit', 'forbidden-mutation', 'invalid-workspace', 'cancelled',
];
const RETRYABLE_FAILURES = new Set<VerificationFailureCode>(['command-failed']);

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('invalid-agent-output', `${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[], code: string, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError(code, `${where} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new CoreError(code, `${where} contains an unexpected field`);
  return result;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new CoreError('invalid-agent-output', `${where} has an unknown field`);
}

function encodedSize(value: string, ceiling = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
    if (bytes > ceiling) return bytes;
  }
  return bytes;
}

function hasInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isPlainJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('not JSON');
    return json;
  } catch {
    throw new CoreError('invalid-agent-output', 'Agent response is not bounded JSON data');
  }
}

function assertSerializedSize(value: unknown, maxBytes: number, code: string, where: string): void {
  const serialized = isPlainJson(value);
  if (encodedSize(serialized, maxBytes) > maxBytes) {
    throw new CoreError(code, `${where} exceeds its serialized byte limit`);
  }
}

function validCommit(value: string): boolean {
  return COMMIT_PATTERN.test(value);
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.fullName.toLowerCase() === right.fullName.toLowerCase()
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.name.toLowerCase() === right.name.toLowerCase();
}

function repositoryIsSane(repository: RepositoryIdentity): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(repository.owner)
    && /^[A-Za-z0-9_.-]+$/.test(repository.name)
    && repository.fullName.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase();
}

function validBranchName(ref: string): boolean {
  return ref.length > 0 && ref.length <= 255 && !ref.startsWith('-') && !ref.startsWith('/')
    && !ref.endsWith('/') && !ref.endsWith('.') && !ref.includes('..') && !ref.includes('@{')
    && !ref.includes('//') && !/[ ~^:?*\[\\\x00-\x20\x7f]/.test(ref);
}

function validateRegistration(registration: TrackingRegistration, digest: string): void {
  const raw = exactRecord(registration, [
    'id', 'installationId', 'target', 'baseBranch', 'upstream', 'policy', 'policyHash',
    'lastCheckedCommit', 'lastSyncedCommit', 'active', 'revision',
  ], 'stale-registration', 'Tracking registration');
  const target = exactRecord(raw.target, ['owner', 'name', 'fullName'], 'stale-registration', 'Tracking target');
  const upstream = exactRecord(raw.upstream, ['repository', 'ref', 'baselineCommit'], 'stale-registration', 'Tracking upstream');
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 256
    || typeof raw.installationId !== 'number' || !Number.isSafeInteger(raw.installationId) || raw.installationId < 1
    || typeof target.owner !== 'string' || typeof target.name !== 'string' || typeof target.fullName !== 'string'
    || typeof raw.baseBranch !== 'string' || !validBranchName(raw.baseBranch)
    || typeof upstream.repository !== 'string' || typeof upstream.ref !== 'string' || typeof upstream.baselineCommit !== 'string'
    || !validCommit(upstream.baselineCommit)
    || typeof raw.policyHash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.policyHash) || raw.policyHash !== digest
    || typeof raw.lastCheckedCommit !== 'string' || typeof raw.lastSyncedCommit !== 'string'
    || !validCommit(raw.lastCheckedCommit) || !validCommit(raw.lastSyncedCommit)
    || typeof raw.active !== 'boolean' || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw new CoreError('stale-registration', 'Stored tracking registration is malformed');
  }
  const identity: RepositoryIdentity = { owner: target.owner, name: target.name, fullName: target.fullName };
  if (!repositoryIsSane(identity)) throw new CoreError('stale-registration', 'Stored target identity is inconsistent');
}

function isoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stableJson(input[key])}`).join(',')}}`;
}

async function idForJob(registration: TrackingRegistration, plan: DiscoveredPlan, policyDigest: string): Promise<string> {
  const identity = stableJson({
    installationId: registration.installationId,
    trackingId: registration.id,
    target: registration.target.fullName.toLowerCase(),
    baseBranch: registration.baseBranch,
    targetBaseCommit: plan.targetBaseCommit.toLowerCase(),
    policyHash: policyDigest,
    upstreamRepository: plan.upstreamRepository.toLowerCase(),
    upstreamRef: plan.upstreamRef,
    fromCommit: plan.fromCommit.toLowerCase(),
    upstreamCommit: plan.toCommit.toLowerCase(),
  });
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `job_${hash}`;
}

async function idForSyncOriginBlock(registration: TrackingRegistration, plan: PinnedPlan, policyDigest: string): Promise<string> {
  const identity = stableJson({
    purpose: 'sync-origin-generation-limit',
    installationId: registration.installationId,
    trackingId: registration.id,
    target: registration.target.fullName.toLowerCase(),
    baseBranch: registration.baseBranch,
    policyHash: policyDigest,
    upstreamRepository: plan.upstreamRepository.toLowerCase(),
    upstreamRef: plan.upstreamRef,
    fromCommit: plan.fromCommit.toLowerCase(),
  });
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `job_${hash}`;
}

async function persistSyncOriginGenerationBlock(
  registration: TrackingRegistration,
  plan: PinnedPlan,
  ports: CorePorts,
): Promise<JobRunResult> {
  const id = await idForSyncOriginBlock(registration, plan, plan.policyHash);
  const blockedPlan: PinnedPlan = { ...plan, jobId: id, jobKey: id };
  const created = await ports.store.createOrGetJob({
    id,
    key: id,
    trackingId: registration.id,
    plan: blockedPlan,
    stepsUsed: 0,
  });
  if (!created.created) return resultForExisting(created.job);
  const job = await save(ports, created.job, {
    status: 'failed',
    stage: 'terminal',
    failure: { code: 'sync-origin-generation-limit' },
  });
  return { status: 'failed', job };
}

function validateDiscoveredPlan(registration: TrackingRegistration, policy: CloudflarePolicy, digest: string, plan: DiscoveredPlan): void {
  const rawPlan = exactRecord(plan, [
    'trackingId', 'installationId', 'target', 'baseBranch', 'targetBaseCommit', 'upstreamRepository', 'upstreamRef',
    'fromCommit', 'expectedLastCheckedCommit', 'toCommit', 'commitCount', 'changedFiles', 'changedPaths',
    'checkedChangedPaths', 'observedAt',
  ], 'invalid-plan', 'GitHub plan');
  const target = exactRecord(rawPlan.target, ['owner', 'name', 'fullName'], 'invalid-plan', 'GitHub plan target');
  if (typeof rawPlan.trackingId !== 'string' || typeof rawPlan.installationId !== 'number'
    || typeof target.owner !== 'string' || typeof target.name !== 'string' || typeof target.fullName !== 'string'
    || typeof rawPlan.baseBranch !== 'string' || typeof rawPlan.targetBaseCommit !== 'string'
    || typeof rawPlan.upstreamRepository !== 'string' || typeof rawPlan.upstreamRef !== 'string'
    || typeof rawPlan.fromCommit !== 'string' || typeof rawPlan.expectedLastCheckedCommit !== 'string'
    || typeof rawPlan.toCommit !== 'string' || typeof rawPlan.commitCount !== 'number'
    || !Array.isArray(rawPlan.changedFiles) || !Array.isArray(rawPlan.changedPaths)
    || !Array.isArray(rawPlan.checkedChangedPaths) || typeof rawPlan.observedAt !== 'string'
    || rawPlan.changedFiles.length > policy.limits.maxChangedPaths
    || rawPlan.changedPaths.length > policy.limits.maxChangedPaths
    || rawPlan.checkedChangedPaths.length > policy.limits.maxChangedPaths) {
    throw new CoreError('invalid-plan', 'GitHub adapter returned malformed plan data');
  }
  const changedFiles: Array<{ path: string; status: string }> = [];
  const changedFilePaths = new Set<string>();
  for (const value of rawPlan.changedFiles) {
    const file = exactRecord(value, ['path', 'status'], 'invalid-plan', 'GitHub changed file');
    if (typeof file.path !== 'string' || !safePath(file.path)
      || (file.status !== 'added' && file.status !== 'modified' && file.status !== 'deleted')
      || changedFilePaths.has(file.path)) {
      throw new CoreError('invalid-plan', 'GitHub changed-file classifications are unsafe or duplicated');
    }
    changedFilePaths.add(file.path);
    changedFiles.push({ path: file.path, status: file.status });
  }
  const changedPaths = new Set<string>();
  for (const path of rawPlan.changedPaths) {
    if (typeof path !== 'string' || !safePath(path) || changedPaths.has(path)) {
      throw new CoreError('invalid-plan', 'GitHub changed paths are unsafe or duplicated');
    }
    changedPaths.add(path);
  }
  const checkedChangedPaths = new Set<string>();
  for (const path of rawPlan.checkedChangedPaths) {
    if (typeof path !== 'string' || !safePath(path) || checkedChangedPaths.has(path)) {
      throw new CoreError('invalid-plan', 'GitHub checked paths are unsafe or duplicated');
    }
    checkedChangedPaths.add(path);
  }
  if (changedPaths.size !== changedFilePaths.size || [...changedPaths].some(path => !changedFilePaths.has(path))) {
    throw new CoreError('invalid-plan', 'GitHub changed paths do not exactly match changed-file classifications');
  }
  const normalizedTarget: RepositoryIdentity = { owner: target.owner, name: target.name, fullName: target.fullName };
  if (plan.trackingId !== registration.id || plan.installationId !== registration.installationId
    || !sameRepository(normalizedTarget, registration.target) || !repositoryIsSane(normalizedTarget)
    || !validBranchName(plan.baseBranch) || plan.baseBranch !== registration.baseBranch
    || plan.upstreamRepository !== policy.upstream.repository || plan.upstreamRef !== policy.upstream.ref
    || plan.fromCommit !== registration.lastSyncedCommit
    || plan.expectedLastCheckedCommit !== registration.lastCheckedCommit
    || !validCommit(plan.targetBaseCommit) || !validCommit(plan.fromCommit)
    || !validCommit(plan.expectedLastCheckedCommit) || !validCommit(plan.toCommit)
    || !Number.isSafeInteger(plan.commitCount) || plan.commitCount < 0 || plan.commitCount > policy.limits.maxCommits
    || plan.changedFiles.length > policy.limits.maxChangedPaths
    || plan.checkedChangedPaths.length > policy.limits.maxChangedPaths
    || !isoDate(plan.observedAt)
    || registration.policyHash !== digest) {
    throw new CoreError('invalid-plan', 'GitHub adapter returned a plan that does not match the active synchronized checkpoint');
  }
  if (plan.toCommit === plan.fromCommit && plan.commitCount !== 0) {
    throw new CoreError('invalid-plan', 'GitHub adapter returned inconsistent unchanged-commit metadata');
  }
  if (plan.toCommit === plan.fromCommit && (plan.changedFiles.length !== 0 || plan.checkedChangedPaths.length !== 0)) {
    throw new CoreError('invalid-plan', 'GitHub adapter returned file changes for an unchanged commit');
  }
}

async function pinPlan(
  registration: TrackingRegistration,
  policy: CloudflarePolicy,
  digest: string,
  discovered: DiscoveredPlan,
  work: GlobWorkBudget,
): Promise<PinnedPlan> {
  validateDiscoveredPlan(registration, policy, digest, discovered);
  assertSerializedSize({
    changedFiles: discovered.changedFiles,
    changedPaths: discovered.changedPaths,
    checkedChangedPaths: discovered.checkedChangedPaths,
  }, policy.limits.maxContextBytes, 'snapshot-limit', 'Changed-path metadata');
  const filtered = filterChangedPaths(policy, discovered.changedPaths, work);
  const checkedFiltered = filterChangedPaths(policy, discovered.checkedChangedPaths, work);
  const jobId = await idForJob(registration, discovered, digest);
  const plan: PinnedPlan = {
    trackingId: discovered.trackingId,
    installationId: discovered.installationId,
    target: { owner: discovered.target.owner, name: discovered.target.name, fullName: discovered.target.fullName },
    baseBranch: discovered.baseBranch,
    targetBaseCommit: discovered.targetBaseCommit,
    upstreamRepository: discovered.upstreamRepository,
    upstreamRef: discovered.upstreamRef,
    fromCommit: discovered.fromCommit,
    expectedLastCheckedCommit: discovered.expectedLastCheckedCommit,
    toCommit: discovered.toCommit,
    commitCount: discovered.commitCount,
    changedFiles: discovered.changedFiles.map(file => ({ ...file })),
    changedPaths: [...new Set(discovered.changedPaths)],
    checkedChangedPaths: [...new Set(discovered.checkedChangedPaths)],
    observedAt: discovered.observedAt,
    jobId,
    jobKey: jobId,
    policyHash: digest,
    selectedUpstreamPaths: filtered.selectedPaths,
    checkedSelectedUpstreamPaths: checkedFiltered.selectedPaths,
    selectedSelectionIds: policy.selections.filter(selection => filtered.selectionPaths[selection.id]!.length > 0).map(selection => selection.id),
  };
  return plan;
}

function rejectExtraFields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  assertOnlyKeys(value, allowed, where);
}

function validateReport(value: unknown, expectedSelectionIds: readonly string[], policy: CloudflarePolicy): AgentReport {
  const report = record(value, 'report');
  rejectExtraFields(report, ['summary', 'decisions'], 'report');
  if (typeof report.summary !== 'string' || !report.summary.trim() || encodedSize(report.summary) > 20_000
    || hasInvalidUnicode(report.summary) || !Array.isArray(report.decisions) || report.decisions.length !== expectedSelectionIds.length) {
    throw new CoreError('invalid-report', 'Agent report must contain a bounded summary and one decision per selected rule');
  }
  const expected = new Set(expectedSelectionIds);
  const seen = new Set<string>();
  const decisions = report.decisions.map((raw: unknown, index: number) => {
    const decision = record(raw, `decisions[${index}]`);
    rejectExtraFields(decision, ['selection', 'status', 'reason'], `decisions[${index}]`);
    if (typeof decision.selection !== 'string' || !expected.has(decision.selection) || seen.has(decision.selection)
      || !['applied', 'skipped', 'blocked'].includes(String(decision.status))
      || typeof decision.reason !== 'string' || !decision.reason.trim() || encodedSize(decision.reason) > 20_000
      || hasInvalidUnicode(decision.reason)) {
      throw new CoreError('invalid-report', 'Each selected rule needs one unique applied/skipped/blocked decision with a bounded reason');
    }
    seen.add(decision.selection);
    return {
      selection: decision.selection,
      status: decision.status as 'applied' | 'skipped' | 'blocked',
      reason: decision.reason,
    };
  });
  if (seen.size !== expected.size) throw new CoreError('invalid-report', 'Agent report omitted a selected rule');
  const parsed = { summary: report.summary, decisions };
  if (encodedSize(isPlainJson(parsed), policy.limits.maxResponseBytes) > policy.limits.maxResponseBytes) {
    throw new CoreError('response-limit', 'Agent report exceeds maxResponseBytes');
  }
  return parsed;
}

function validateEdits(
  value: unknown,
  policy: CloudflarePolicy,
  plan: PinnedPlan,
  target: TargetSnapshot,
  report: AgentReport,
  work: GlobWorkBudget,
): StagedFileEdit[] {
  if (!Array.isArray(value) || value.length > policy.limits.maxFiles) throw new CoreError('invalid-edits', 'Agent edits must be a bounded array');
  const applied = new Set(report.decisions.filter(item => item.status === 'applied').map(item => item.selection));
  const skipped = new Set(report.decisions.filter(item => item.status === 'skipped').map(item => item.selection));
  const originalFiles = new Map(target.files.map(file => [file.path, file.content]));
  const existingPaths = new Set(target.existingPaths);
  const seen = new Set<string>();
  const edits: StagedFileEdit[] = [];

  for (let index = 0; index < value.length; index++) {
    const raw = record(value[index], `edits[${index}]`);
    rejectExtraFields(raw, ['path', 'operation', 'content'], `edits[${index}]`);
    if (typeof raw.path !== 'string' || !safePath(raw.path) || typeof raw.operation !== 'string'
      || !EDIT_OPERATIONS.includes(raw.operation as (typeof EDIT_OPERATIONS)[number])) {
      throw new CoreError('invalid-edits', 'Agent edit contains an unsafe path or unsupported operation');
    }
    const path = raw.path;
    if (seen.has(path)) throw new CoreError('invalid-edits', 'Agent returned duplicate edits for one path');
    seen.add(path);
    if (isProtectedOrSensitive(path, policy, work)) throw new CoreError('protected-edit', 'Agent attempted to edit an internal, protected, or sensitive path');
    const matching = policy.selections.filter(selection => plan.selectedSelectionIds.includes(selection.id)
      && matchesAny(path, selection.targetPaths, work));
    if (!matching.length || !matching.some(selection => applied.has(selection.id))) {
      throw new CoreError('out-of-scope-edit', 'Agent edit is outside an applied selection target scope');
    }
    if (matching.some(selection => skipped.has(selection.id))) {
      throw new CoreError('decision-edit-mismatch', 'An edit overlaps a selection reported as skipped');
    }

    if (raw.operation === 'write') {
      if (typeof raw.content !== 'string' || raw.content.includes('\0') || hasInvalidUnicode(raw.content)) {
        throw new CoreError('invalid-edits', 'Write edits must contain valid UTF-8 text without NUL bytes');
      }
      const sizeBytes = encodedSize(raw.content);
      if (sizeBytes > policy.limits.maxFileBytes) throw new CoreError('response-limit', 'A staged file exceeds maxFileBytes');
      if (existingPaths.has(path) && !originalFiles.has(path)) throw new CoreError('invalid-snapshot', 'Existing target file was omitted from the pinned snapshot');
      if (originalFiles.get(path) === raw.content) throw new CoreError('no-actual-edit', 'Agent staged a write that does not change target content');
      edits.push({ path, operation: 'write', content: raw.content });
    } else {
      if (Object.hasOwn(raw, 'content')) throw new CoreError('invalid-edits', 'Delete edits must not include content');
      if (!originalFiles.has(path)) throw new CoreError('invalid-edits', 'Agent attempted to delete a path absent from the pinned target snapshot');
      edits.push({ path, operation: 'delete' });
    }
  }

  for (const decision of report.decisions) {
    if (decision.status === 'applied' && !edits.some(edit => matchesAny(
      edit.path,
      policy.selections.find(selection => selection.id === decision.selection)!.targetPaths,
      work,
    ))) {
      throw new CoreError('decision-edit-mismatch', `Applied selection ${decision.selection} has no actual target edit`);
    }
  }
  if (edits.length > 0 && report.decisions.every(decision => decision.status !== 'applied')) {
    throw new CoreError('decision-edit-mismatch', 'Edits cannot accompany skipped-only decisions');
  }
  if (report.decisions.some(decision => decision.status === 'blocked')) {
    throw new CoreError('agent-blocked', 'Agent reported a blocked selection');
  }
  return edits;
}

function validateSnapshotFiles(value: unknown, policy: CloudflarePolicy, requestedPaths: readonly string[], where: string): { files: SnapshotFile[]; bytes: number } {
  if (!Array.isArray(value) || value.length > policy.limits.maxFiles) throw new CoreError('snapshot-limit', `${where} contains too many files`);
  const requested = new Set(requestedPaths);
  const seen = new Set<string>();
  let total = 0;
  const files: SnapshotFile[] = [];
  for (const raw of value) {
    const file = exactRecord(raw, ['path', 'content', 'sizeBytes', 'mode'], 'invalid-snapshot', `${where} file`);
    if (typeof file.path !== 'string' || !safePath(file.path) || seen.has(file.path) || !requested.has(file.path)
      || typeof file.content !== 'string' || file.content.includes('\0') || hasInvalidUnicode(file.content)
      || typeof file.sizeBytes !== 'number' || (file.mode !== '100644' && file.mode !== '100755')) {
      throw new CoreError('invalid-snapshot', `${where} contains an unsafe, duplicate, unrequested, or non-text file`);
    }
    seen.add(file.path);
    const actualSize = encodedSize(file.content);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes !== actualSize || actualSize > policy.limits.maxFileBytes) {
      throw new CoreError('snapshot-limit', `${where} file size does not match bounded UTF-8 content`);
    }
    total += actualSize;
    files.push({ path: file.path, content: file.content, sizeBytes: actualSize, mode: file.mode });
  }
  return { files, bytes: total };
}

function validateSourceSnapshot(value: SourceSnapshot, plan: PinnedPlan, policy: CloudflarePolicy): { snapshot: SourceSnapshot; bytes: number; entries: number } {
  const raw = exactRecord(value, ['repository', 'beforeCommit', 'beforeFiles', 'commit', 'files', 'deletedPaths'], 'invalid-snapshot', 'Source snapshot');
  if (raw.repository !== plan.upstreamRepository || raw.beforeCommit !== plan.fromCommit || raw.commit !== plan.toCommit
    || !Array.isArray(raw.beforeFiles) || !Array.isArray(raw.files) || !Array.isArray(raw.deletedPaths)
    || raw.beforeFiles.length > policy.limits.maxFiles || raw.files.length > policy.limits.maxFiles
    || raw.deletedPaths.length > policy.limits.maxFiles) {
    throw new CoreError('invalid-snapshot', 'Source snapshot does not match both pinned upstream commits');
  }
  const selectedChanges = plan.changedFiles.filter(change => plan.selectedUpstreamPaths.includes(change.path));
  if (selectedChanges.length !== plan.selectedUpstreamPaths.length
    || selectedChanges.some(change => !plan.selectedUpstreamPaths.includes(change.path))) {
    throw new CoreError('invalid-plan', 'Selected source paths do not map one-to-one to classified changes');
  }
  const expectedBefore = new Set(selectedChanges.filter(change => change.status !== 'added').map(change => change.path));
  const expectedAfter = new Set(selectedChanges.filter(change => change.status !== 'deleted').map(change => change.path));
  const expectedDeleted = new Set(selectedChanges.filter(change => change.status === 'deleted').map(change => change.path));
  const before = validateSnapshotFiles(raw.beforeFiles, policy, [...expectedBefore], 'Source-before snapshot');
  const after = validateSnapshotFiles(raw.files, policy, [...expectedAfter], 'Source-after snapshot');
  if (before.files.length !== expectedBefore.size || after.files.length !== expectedAfter.size
    || before.files.some(file => !expectedBefore.has(file.path)) || after.files.some(file => !expectedAfter.has(file.path))) {
    throw new CoreError('invalid-snapshot', 'Source before/after contents do not match add/modify/delete classifications');
  }
  const deleted = new Set<string>();
  for (const candidate of raw.deletedPaths) {
    if (typeof candidate !== 'string' || !safePath(candidate) || deleted.has(candidate)) {
      throw new CoreError('invalid-snapshot', 'Source snapshot contains an invalid deleted path');
    }
    deleted.add(candidate);
  }
  if (deleted.size !== expectedDeleted.size || [...deleted].some(path => !expectedDeleted.has(path))) {
    throw new CoreError('invalid-snapshot', 'Deleted paths do not match the pinned change classifications');
  }
  // `maxFiles` counts unique changed paths, not two serialized versions of a
  // modification. Both versions remain covered by the combined byte/JSON caps.
  const entries = selectedChanges.length;
  return {
    snapshot: {
      repository: plan.upstreamRepository,
      beforeCommit: plan.fromCommit,
      beforeFiles: before.files,
      commit: plan.toCommit,
      files: after.files,
      deletedPaths: [...deleted],
    },
    bytes: before.bytes + after.bytes,
    entries,
  };
}

function targetPatterns(policy: CloudflarePolicy, selectionIds: readonly string[]): string[] {
  return [...new Set(policy.selections.filter(selection => selectionIds.includes(selection.id)).flatMap(selection => selection.targetPaths))];
}

function validateTargetSnapshot(
  value: TargetSnapshot,
  registration: TrackingRegistration,
  plan: PinnedPlan,
  policy: CloudflarePolicy,
  work: GlobWorkBudget,
): { snapshot: TargetSnapshot; bytes: number; entries: number } {
  const raw = exactRecord(value, ['repository', 'baseBranch', 'commit', 'existingPaths', 'files'], 'invalid-snapshot', 'Target snapshot');
  const repository = exactRecord(raw.repository, ['owner', 'name', 'fullName'], 'invalid-snapshot', 'Target snapshot repository');
  if (typeof repository.owner !== 'string' || typeof repository.name !== 'string' || typeof repository.fullName !== 'string'
    || typeof raw.baseBranch !== 'string' || typeof raw.commit !== 'string'
    || !Array.isArray(raw.existingPaths) || raw.existingPaths.length > policy.limits.maxFiles || !Array.isArray(raw.files)) {
    throw new CoreError('invalid-snapshot', 'Target snapshot does not match the pinned configured base');
  }
  const repositoryIdentity: RepositoryIdentity = { owner: repository.owner, name: repository.name, fullName: repository.fullName };
  if (!sameRepository(repositoryIdentity, registration.target) || raw.baseBranch !== registration.baseBranch || raw.commit !== plan.targetBaseCommit) {
    throw new CoreError('invalid-snapshot', 'Target snapshot does not match the pinned configured base');
  }
  const patterns = targetPatterns(policy, plan.selectedSelectionIds);
  const existingPaths = new Set<string>();
  for (const candidate of raw.existingPaths) {
    if (typeof candidate !== 'string' || !safePath(candidate) || existingPaths.has(candidate)
      || !matchesAny(candidate, patterns, work) || isProtectedOrSensitive(candidate, policy, work)) {
      throw new CoreError('invalid-snapshot', 'Target inventory contains an unsafe, protected, duplicate, or out-of-scope path');
    }
    existingPaths.add(candidate);
  }
  const validatedFiles = validateSnapshotFiles(raw.files, policy, [...existingPaths], 'Target snapshot');
  const filePaths = new Set(validatedFiles.files.map(file => file.path));
  for (const file of validatedFiles.files) {
    if (!matchesAny(file.path, patterns, work) || !existingPaths.has(file.path)) {
      throw new CoreError('invalid-snapshot', 'Target snapshot includes a file outside its complete path inventory');
    }
  }
  if (filePaths.size !== existingPaths.size || [...existingPaths].some(path => !filePaths.has(path))) {
    throw new CoreError('invalid-snapshot', 'Target snapshot must include every readable file in its selected path inventory');
  }
  return {
    snapshot: {
      repository: repositoryIdentity,
      baseBranch: raw.baseBranch,
      commit: raw.commit,
      existingPaths: [...existingPaths],
      files: validatedFiles.files,
    },
    bytes: validatedFiles.bytes,
    entries: existingPaths.size,
  };
}

function validateVerificationWorkspace(
  value: VerificationWorkspaceSnapshot,
  registration: TrackingRegistration,
  plan: PinnedPlan,
  target: TargetSnapshot,
  policy: CloudflarePolicy,
  limits: VerificationWorkspaceLimits,
  work: GlobWorkBudget,
): VerificationWorkspaceSnapshot {
  const raw = exactRecord(value, ['complete', 'repository', 'baseBranch', 'commit', 'existingPaths', 'files'],
    'invalid-verification-workspace', 'Complete verification workspace');
  const repository = exactRecord(raw.repository, ['owner', 'name', 'fullName'],
    'invalid-verification-workspace', 'Verification workspace repository');
  if (raw.complete !== true || typeof repository.owner !== 'string' || typeof repository.name !== 'string'
    || typeof repository.fullName !== 'string' || typeof raw.baseBranch !== 'string'
    || typeof raw.commit !== 'string' || !Array.isArray(raw.existingPaths) || !Array.isArray(raw.files)
    || raw.existingPaths.length > limits.maxFiles || raw.files.length > limits.maxFiles) {
    throw new CoreError('invalid-verification-workspace', 'Host did not provide a complete bounded verification workspace');
  }
  const identity: RepositoryIdentity = { owner: repository.owner, name: repository.name, fullName: repository.fullName };
  if (!repositoryIsSane(identity) || !sameRepository(identity, registration.target)
    || raw.baseBranch !== registration.baseBranch || raw.commit !== plan.targetBaseCommit) {
    throw new CoreError('invalid-verification-workspace', 'Verification workspace does not match the pinned target base');
  }

  const existingPaths = new Set<string>();
  const directories = new Set<string>();
  for (const candidate of raw.existingPaths) {
    if (typeof candidate !== 'string' || !safePath(candidate)
      || encodedSize(candidate) > limits.maxPathBytes || candidate.split('/').length > limits.maxPathDepth
      || existingPaths.has(candidate) || isProtectedOrSensitive(candidate, policy, work)) {
      throw new CoreError('invalid-verification-workspace', 'Verification inventory contains an unsafe, excluded, duplicate, or oversized path');
    }
    existingPaths.add(candidate);
    const parts = candidate.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
    if (directories.size > limits.maxDirectories) {
      throw new CoreError('verification-workspace-limit', 'Verification directory inventory exceeds its bound');
    }
  }
  for (const path of existingPaths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (existingPaths.has(parts.slice(0, index).join('/'))) {
        throw new CoreError('invalid-verification-workspace', 'Verification inventory contains a file/directory collision');
      }
    }
  }

  const files: SnapshotFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const candidate of raw.files) {
    const file = exactRecord(candidate, ['path', 'content', 'sizeBytes', 'mode'],
      'invalid-verification-workspace', 'Verification workspace file');
    if (typeof file.path !== 'string' || !safePath(file.path) || !existingPaths.has(file.path) || seen.has(file.path)
      || typeof file.content !== 'string' || file.content.includes('\0') || hasInvalidUnicode(file.content)
      || (file.mode !== '100644' && file.mode !== '100755') || typeof file.sizeBytes !== 'number') {
      throw new CoreError('invalid-verification-workspace', 'Verification workspace contains an unsafe, missing, duplicate, or non-text file');
    }
    const sizeBytes = encodedSize(file.content, limits.maxFileBytes);
    if (!Number.isSafeInteger(file.sizeBytes) || sizeBytes !== file.sizeBytes || sizeBytes > limits.maxFileBytes) {
      throw new CoreError('verification-workspace-limit', 'Verification file size does not match its bounded UTF-8 content');
    }
    totalBytes += sizeBytes;
    if (totalBytes > limits.maxBytes) throw new CoreError('verification-workspace-limit', 'Complete verification tree exceeds its byte limit');
    seen.add(file.path);
    files.push({ path: file.path, content: file.content, sizeBytes, mode: file.mode });
  }
  if (seen.size !== existingPaths.size || [...existingPaths].some(path => !seen.has(path))) {
    throw new CoreError('invalid-verification-workspace', 'Complete verification workspace omitted an inventory file');
  }
  const fullByPath = new Map(files.map(file => [file.path, file]));
  // The model-scoped target is validated separately; the complete workspace must
  // contain the exact same version of every pinned target file and path.
  for (const pinned of target.files) {
    const complete = fullByPath.get(pinned.path);
    if (!complete || complete.content !== pinned.content || complete.mode !== pinned.mode) {
      throw new CoreError('invalid-verification-workspace', 'Verification tree does not contain the pinned agent snapshot');
    }
  }
  for (const path of target.existingPaths) {
    if (!existingPaths.has(path)) {
      throw new CoreError('invalid-verification-workspace', 'Verification tree omits a path from the pinned agent inventory');
    }
  }
  assertSerializedSize({ complete: true, repository: identity, baseBranch: raw.baseBranch, commit: raw.commit, existingPaths: [...existingPaths], files },
    limits.maxSerializedBytes, 'verification-workspace-limit', 'Complete verification workspace');
  return {
    complete: true,
    repository: identity,
    baseBranch: raw.baseBranch,
    commit: raw.commit,
    existingPaths: [...existingPaths],
    files,
  };
}

async function parseVerificationResult(
  value: unknown,
  policy: CloudflarePolicy,
  remainingJobMs: number,
  target: TargetSnapshot,
  edits: readonly StagedFileEdit[],
): Promise<VerificationResult> {
  const result = record(value, 'verification result');
  rejectExtraFields(result, ['status', 'steps', 'workspaceFiles', 'failureCode'], 'verification result');
  if (!['passed', 'failed'].includes(String(result.status)) || !Array.isArray(result.steps)
    || result.steps.length > policy.verification.length || !Array.isArray(result.workspaceFiles)
    || result.workspaceFiles.length > policy.limits.maxFiles) {
    throw new CoreError('invalid-verification-result', 'Runner returned a malformed verification result');
  }
  const steps: VerificationStepResult[] = result.steps.map((raw: unknown, index: number) => {
    const step = record(raw, `verification.steps[${index}]`);
    rejectExtraFields(step, ['index', 'exitCode', 'durationMs', 'stdoutBytes', 'stderrBytes'], `verification.steps[${index}]`);
    if (!Number.isSafeInteger(step.index) || step.index !== index
      || !(step.exitCode === null || (typeof step.exitCode === 'number' && Number.isSafeInteger(step.exitCode) && step.exitCode >= 0 && step.exitCode <= 255))
      || !Number.isSafeInteger(step.durationMs) || Number(step.durationMs) < 0
      || !Number.isSafeInteger(step.stdoutBytes) || Number(step.stdoutBytes) < 0
      || !Number.isSafeInteger(step.stderrBytes) || Number(step.stderrBytes) < 0
      || Number(step.stdoutBytes) + Number(step.stderrBytes) > policy.limits.maxVerificationOutputBytes) {
      throw new CoreError('invalid-verification-result', 'Runner returned unbounded or inconsistent step evidence');
    }
    return {
      index: Number(step.index),
      exitCode: step.exitCode as number | null,
      durationMs: Number(step.durationMs),
      stdoutBytes: Number(step.stdoutBytes),
      stderrBytes: Number(step.stderrBytes),
    };
  });
  let failureCode: VerificationFailureCode | undefined;
  if (result.failureCode !== undefined) {
    if (typeof result.failureCode !== 'string' || !VERIFICATION_CODES.includes(result.failureCode as VerificationFailureCode)) {
      throw new CoreError('invalid-verification-result', 'Runner returned an unknown failure category');
    }
    failureCode = result.failureCode as VerificationFailureCode;
  }
  if (result.status === 'passed' && (steps.length !== policy.verification.length || steps.some(step => step.exitCode !== 0) || failureCode !== undefined)) {
    throw new CoreError('invalid-verification-result', 'Runner marked incomplete or failed checks as passed');
  }
  if (result.status === 'failed' && (!failureCode || !steps.length)) {
    throw new CoreError('invalid-verification-result', 'Runner failure must identify a bounded failure category and evidence');
  }
  if (failureCode === 'command-failed' && !steps.some(step => step.exitCode !== null && step.exitCode !== 0)) {
    throw new CoreError('invalid-verification-result', 'A command-failed result must contain a nonzero exit code');
  }
  if (failureCode === 'timed-out' && !steps.some(step => step.exitCode === null)) {
    throw new CoreError('invalid-verification-result', 'A timed-out result must identify a timed-out step');
  }
  const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0);
  const totalOutputBytes = steps.reduce((sum, step) => sum + step.stdoutBytes + step.stderrBytes, 0);
  if (totalMs > policy.limits.maxJobSeconds * 1_000 || totalMs > remainingJobMs) {
    throw new CoreError('verification-limit', 'Verification exceeded the remaining job time budget');
  }
  if (totalOutputBytes > policy.limits.maxVerificationOutputBytes) {
    throw new CoreError('verification-limit', 'Verification evidence exceeded maxVerificationOutputBytes');
  }
  for (const step of steps) {
    if (step.durationMs > policy.verification[step.index]!.timeoutSeconds * 1_000) {
      throw new CoreError('verification-limit', 'Runner exceeded a configured per-command timeout');
    }
  }

  const expected = new Map(edits.map(edit => [edit.path, edit]));
  const originalModes = new Map(target.files.map(file => [file.path, file.mode]));
  const seen = new Set<string>();
  const workspaceFiles: WorkspaceFileEvidence[] = [];
  for (let index = 0; index < result.workspaceFiles.length; index++) {
    const file = record(result.workspaceFiles[index], `verification.workspaceFiles[${index}]`);
    if (file.operation === 'delete') {
      rejectExtraFields(file, ['path', 'operation'], `verification.workspaceFiles[${index}]`);
      if (typeof file.path !== 'string' || !safePath(file.path)) {
        throw new CoreError('invalid-verification-result', 'Runner reported an unsafe workspace path');
      }
      workspaceFiles.push({ path: file.path, operation: 'delete' });
    } else if (file.operation === 'write') {
      rejectExtraFields(file, ['path', 'operation', 'sha256', 'mode'], `verification.workspaceFiles[${index}]`);
      if (typeof file.path !== 'string' || !safePath(file.path) || typeof file.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(file.sha256) || (file.mode !== '100644' && file.mode !== '100755')) {
        throw new CoreError('invalid-verification-result', 'Runner returned malformed workspace content evidence');
      }
      workspaceFiles.push({ path: file.path, operation: 'write', sha256: file.sha256, mode: file.mode });
    } else {
      throw new CoreError('invalid-verification-result', 'Runner returned an unsupported workspace operation');
    }
    const normalized = workspaceFiles[workspaceFiles.length - 1]!;
    if (seen.has(normalized.path)) throw new CoreError('invalid-verification-result', 'Runner reported duplicate workspace paths');
    seen.add(normalized.path);
    const edit = expected.get(normalized.path);
    if (!edit || edit.operation !== normalized.operation) {
      throw new CoreError('forbidden-mutation', 'Verification changed files outside the exact staged edit set');
    }
    if (normalized.operation === 'write' && edit.operation === 'write') {
      const expectedHash = await sha256Text(edit.content!);
      const expectedMode = originalModes.get(edit.path) ?? '100644';
      if (normalized.sha256 !== expectedHash || normalized.mode !== expectedMode) {
        throw new CoreError('forbidden-mutation', 'Verification changed staged file contents or mode');
      }
    }
  }
  if (workspaceFiles.length !== expected.size || [...expected.keys()].some(path => !seen.has(path))) {
    throw new CoreError('forbidden-mutation', 'Post-verification workspace diff does not match staged edits');
  }
  return {
    status: result.status as 'passed' | 'failed',
    steps,
    workspaceFiles,
    ...(failureCode ? { failureCode } : {}),
  };
}

function now(ports: CorePorts): string {
  const value = (ports.now ?? (() => new Date().toISOString()))();
  if (!isoDate(value)) throw new CoreError('invalid-clock', 'Core clock returned an invalid timestamp');
  return value;
}

async function save(ports: CorePorts, job: JobRecord, changes: Partial<Omit<JobRecord, 'id' | 'key' | 'trackingId' | 'plan' | 'version' | 'createdAt'>>): Promise<JobRecord> {
  const updated: JobRecord = {
    ...job,
    ...changes,
    version: job.version + 1,
    updatedAt: now(ports),
  };
  return ports.store.saveJob(updated, job.version);
}

function resultForExisting(job: JobRecord): JobRunResult {
  if (job.status === 'queued' || job.status === 'running' || job.status === 'publishing') return { status: 'in-progress', job };
  if (job.status === 'ready-to-publish') return { status: 'ready-to-publish', job };
  if (job.status === 'published' || job.status === 'merged') return { status: 'terminal', job };
  if (job.status === 'no-op') return { status: 'no-op', job };
  if (job.status === 'blocked') return { status: 'blocked', job };
  if (job.status === 'failed') return { status: 'failed', job };
  return { status: 'terminal', job };
}

async function failJob(ports: CorePorts, job: JobRecord, code: string, blocked = false): Promise<JobRecord> {
  return save(ports, job, {
    status: blocked ? 'blocked' : 'failed',
    stage: 'terminal',
    failure: { code },
  });
}

function sanitizeAdapterFailure(error: unknown): string {
  if (error instanceof CoreError) return error.code;
  if (error instanceof PolicyValidationError) return 'policy-validation';
  return 'adapter-failure';
}

function validateAgentOutput(
  raw: AgentOutput,
  policy: CloudflarePolicy,
  plan: PinnedPlan,
  target: TargetSnapshot,
  remainingSteps: number,
  remainingJobMs: number,
  work: GlobWorkBudget,
): {
  report: AgentReport;
  edits: StagedFileEdit[];
} {
  assertSerializedSize(raw, policy.limits.maxResponseBytes, 'response-limit', 'Agent response');
  const response = record(raw, 'agent output');
  rejectExtraFields(response, ['report', 'edits', 'stepsUsed', 'durationMs'], 'agent output');
  if (!Number.isSafeInteger(response.stepsUsed) || Number(response.stepsUsed) < 0 || Number(response.stepsUsed) > remainingSteps
    || !Number.isSafeInteger(response.durationMs) || Number(response.durationMs) < 0
    || Number(response.durationMs) > policy.limits.maxJobSeconds * 1_000
    || Number(response.durationMs) > remainingJobMs) {
    throw new CoreError('agent-limit', 'Agent exceeded the configured step or time bound');
  }
  const report = validateReport(response.report, plan.selectedSelectionIds, policy);
  const edits = validateEdits(response.edits, policy, plan, target, report, work);
  return { report, edits };
}

function buildAgentRequest(
  policy: CloudflarePolicy,
  plan: PinnedPlan,
  source: SourceSnapshot,
  target: TargetSnapshot,
  attempt: number,
  remainingSteps: number,
  remainingJobSeconds: number,
  repair?: { edits: readonly StagedFileEdit[]; result: VerificationResult },
): AgentRequest {
  const failedStepIndices = repair?.result.steps.filter(step => step.exitCode !== 0).map(step => step.index) ?? [];
  return {
    jobId: plan.jobId,
    // Preserve the pinned-plan interface while withholding unrelated path names
    // from the model packet. Full host-side discovery metadata stays durable.
    plan: {
      ...plan,
      changedFiles: plan.changedFiles.filter(change => plan.selectedUpstreamPaths.includes(change.path)),
      changedPaths: [...plan.selectedUpstreamPaths],
      checkedChangedPaths: [...plan.checkedSelectedUpstreamPaths],
      checkedSelectedUpstreamPaths: [...plan.checkedSelectedUpstreamPaths],
    },
    source,
    target,
    selections: policy.selections.filter(selection => plan.selectedSelectionIds.includes(selection.id)),
    preserve: policy.preserve,
    attempt,
    maxAttempts: policy.limits.maxAttempts,
    maxSteps: remainingSteps,
    maxJobSeconds: policy.limits.maxJobSeconds,
    remainingJobSeconds,
    maxResponseBytes: policy.limits.maxResponseBytes,
    maxFileBytes: policy.limits.maxFileBytes,
    ...(repair ? {
      repair: {
        priorEdits: repair.edits,
        failureCode: 'command-failed' as const,
        failedStepIndices,
      },
    } : {}),
  };
}

function prepareProposal(
  registration: TrackingRegistration,
  plan: PinnedPlan,
  report: AgentReport,
  edits: readonly StagedFileEdit[],
  verification: VerificationResult,
): VerifiedJobProposal {
  const checkpointCandidate: CheckpointCandidate = {
    trackingId: registration.id,
    jobId: plan.jobId,
    jobKey: plan.jobKey,
    upstreamCommit: plan.toCommit,
    targetBaseCommit: plan.targetBaseCommit,
    policyHash: plan.policyHash,
    expectedLastCheckedCommit: plan.expectedLastCheckedCommit,
    expectedLastSyncedCommit: registration.lastSyncedCommit,
  };
  return { report, edits, verification, checkpointCandidate };
}

function prepareStagedProposal(
  registration: TrackingRegistration,
  plan: PinnedPlan,
  report: AgentReport,
  edits: readonly StagedFileEdit[],
): JobProposal {
  return {
    report,
    edits,
    checkpointCandidate: {
      trackingId: registration.id,
      jobId: plan.jobId,
      jobKey: plan.jobKey,
      upstreamCommit: plan.toCommit,
      targetBaseCommit: plan.targetBaseCommit,
      policyHash: plan.policyHash,
      expectedLastCheckedCommit: plan.expectedLastCheckedCommit,
      expectedLastSyncedCommit: registration.lastSyncedCommit,
    },
  };
}

async function reconcileLastChecked(ports: CorePorts, registration: TrackingRegistration, plan: PinnedPlan): Promise<boolean> {
  return ports.store.advanceLastCheckedCommit({
    trackingId: registration.id,
    expectedLastCheckedCommit: plan.expectedLastCheckedCommit,
    nextLastCheckedCommit: plan.toCommit,
    policyHash: plan.policyHash,
  });
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, globalThis.performance.now() - startedAt);
}

function remainingMs(startedAt: number, policy: CloudflarePolicy): number {
  return Math.max(0, policy.limits.maxJobSeconds * 1_000 - elapsedMs(startedAt));
}

function requireTimeBudget(startedAt: number, policy: CloudflarePolicy): number {
  const remaining = remainingMs(startedAt, policy);
  if (remaining <= 0) throw new CoreError('job-time-limit', 'Job exceeded maxJobSeconds');
  return remaining;
}

/**
 * Bounded, portable orchestration. This function creates a verified proposal only;
 * adapters publish it separately and activate lastSyncedCommit only after merge confirmation.
 */
export async function runJob(trackingId: string, ports: CorePorts): Promise<JobRunResult> {
  const registration = await ports.store.getTrackingRegistration(trackingId);
  if (!registration || !registration.active) throw new CoreError('inactive-registration', 'Tracking registration is missing or inactive');

  let policy: CloudflarePolicy;
  try {
    policy = parsePolicy(registration.policy);
  } catch {
    throw new CoreError('invalid-policy', 'Stored tracking policy failed validation');
  }
  const digest = await policyHash(policy);
  validateRegistration(registration, digest);
  if (digest !== registration.policyHash || policy.upstream.repository !== registration.upstream.repository
    || policy.upstream.ref !== registration.upstream.ref || !validCommit(registration.lastCheckedCommit)
    || !validCommit(registration.lastSyncedCommit)) {
    throw new CoreError('stale-registration', 'Stored policy hash, upstream, or checkpoint is inconsistent');
  }
  const globWork = createGlobWorkBudget();

  let discovered: DiscoveredPlan | undefined;
  try {
    discovered = await ports.github.discoverPlan(registration, policy);
  } catch {
    throw new CoreError('plan-discovery-failed', 'GitHub plan discovery failed');
  }
  if (!discovered) return { status: 'up-to-date' };

  const plan = await pinPlan(registration, policy, digest, discovered, globWork);
  if (plan.toCommit === plan.fromCommit) return { status: 'up-to-date' };
  const existing = await ports.store.getJobByKey(plan.jobKey);
  if (existing) {
    if (existing.id !== plan.jobId || existing.trackingId !== registration.id
      || existing.plan.fromCommit !== plan.fromCommit || existing.plan.toCommit !== plan.toCommit
      || existing.plan.targetBaseCommit !== plan.targetBaseCommit || existing.plan.policyHash !== digest) {
      throw new CoreError('job-key-conflict', 'Stored cumulative job does not match its pinned source/target generation');
    }
    if ((existing.status === 'ready-to-publish' || existing.status === 'no-op') && existing.plan.toCommit === plan.toCommit) {
      await reconcileLastChecked(ports, registration, plan);
    }
    return resultForExisting(existing);
  }
  if (plan.selectedUpstreamPaths.length === 0) {
    if (!await reconcileLastChecked(ports, registration, plan)) {
      throw new CoreError('checkpoint-conflict', 'Could not advance lastCheckedCommit for unrelated cumulative changes');
    }
    return { status: 'irrelevant', checkedThrough: plan.toCommit };
  }
  const priorSyncOriginJobs = await ports.store.listJobsForSyncOrigin({
    trackingId: registration.id,
    fromCommit: plan.fromCommit,
    policyHash: digest,
    limit: MAX_SYNC_ORIGIN_JOBS_TO_SCAN,
  });
  if (priorSyncOriginJobs.more) {
    throw new CoreError('sync-origin-job-history-limit', 'Cannot safely reconcile the bounded prior-job history');
  }
  const priorGenerationBlock = priorSyncOriginJobs.jobs.find(job => job.failure?.code === 'sync-origin-generation-limit');
  if (priorGenerationBlock) return resultForExisting(priorGenerationBlock);

  if (plan.checkedSelectedUpstreamPaths.length === 0) {
    const selected = new Set(plan.selectedUpstreamPaths);
    const cumulativeEvidence = priorSyncOriginJobs.jobs.filter(job => job.plan.selectedUpstreamPaths.some(path => selected.has(path)));
    const existingCumulative = cumulativeEvidence.find(job => job.plan.targetBaseCommit === plan.targetBaseCommit);
    if (cumulativeEvidence.length === 0) {
      throw new CoreError('cumulative-job-evidence-missing', 'Checked progress has selected cumulative work but no durable job evidence');
    }
    if (existingCumulative) {
      if (!await reconcileLastChecked(ports, registration, plan)) {
        throw new CoreError('checkpoint-conflict', 'Could not advance lastCheckedCommit for irrelevant poll changes');
      }
      return resultForExisting(existingCumulative);
    }
    // A new target base invalidates prior test evidence. Fall through to the
    // bounded generation check and create a fresh pinned verification proposal.
  }

  if (priorSyncOriginJobs.jobs.length >= MAX_INFERENCE_GENERATIONS_PER_SYNC_ORIGIN) {
    return persistSyncOriginGenerationBlock(registration, plan, ports);
  }

  const initial: NewJobRecord = {
    id: plan.jobId,
    key: plan.jobKey,
    trackingId: registration.id,
    plan,
    stepsUsed: 0,
  };
  const created = await ports.store.createOrGetJob(initial);
  if (!created.created) {
    const existing = created.job;
    if (existing.id !== plan.jobId || existing.key !== plan.jobKey || existing.trackingId !== registration.id
      || existing.plan.fromCommit !== plan.fromCommit || existing.plan.toCommit !== plan.toCommit
      || existing.plan.targetBaseCommit !== plan.targetBaseCommit || existing.plan.policyHash !== digest) {
      throw new CoreError('job-key-conflict', 'Stored job does not match its deterministic identity');
    }
    if ((existing.status === 'ready-to-publish' || existing.status === 'no-op') && existing.plan.toCommit === plan.toCommit) {
      // Repairs a crash between durable job completion and the idempotent checked marker update.
      await reconcileLastChecked(ports, registration, existing.plan);
    }
    return resultForExisting(existing);
  }

  let job = created.job;
  const startedAt = globalThis.performance.now();
  job = await save(ports, job, { status: 'running', stage: 'snapshotting' });

  let source: SourceSnapshot;
  let target: TargetSnapshot;
  try {
    const targetPathPatterns = targetPatterns(policy, plan.selectedSelectionIds);
    [source, target] = await Promise.all([
      ports.github.readSourceSnapshot({
        plan,
        paths: plan.selectedUpstreamPaths,
        maxFiles: policy.limits.maxFiles,
        maxFileBytes: policy.limits.maxFileBytes,
        maxBytes: policy.limits.maxContextBytes,
        maxJobSeconds: policy.limits.maxJobSeconds,
      }),
      ports.github.readTargetSnapshot({
        plan,
        pathPatterns: targetPathPatterns,
        excludedPathPatterns: excludedPathPatterns(policy),
        maxFiles: policy.limits.maxFiles,
        maxFileBytes: policy.limits.maxFileBytes,
        maxBytes: policy.limits.maxContextBytes,
        maxJobSeconds: policy.limits.maxJobSeconds,
      }),
    ]);
    const validatedSource = validateSourceSnapshot(source, plan, policy);
    const validatedTarget = validateTargetSnapshot(target, registration, plan, policy, globWork);
    source = validatedSource.snapshot;
    target = validatedTarget.snapshot;
    if (validatedSource.entries + validatedTarget.entries > policy.limits.maxFiles) {
      throw new CoreError('snapshot-limit', 'Combined source files, deletions, and target files exceed maxFiles');
    }
    if (validatedSource.bytes + validatedTarget.bytes > policy.limits.maxContextBytes) throw new CoreError('snapshot-limit', 'Combined source and target snapshots exceed maxContextBytes');
    requireTimeBudget(startedAt, policy);
  } catch (error) {
    job = await failJob(ports, job, sanitizeAdapterFailure(error), error instanceof CoreError && error.code.startsWith('invalid'));
    return { status: job.status === 'blocked' ? 'blocked' : 'failed', job };
  }

  let repair: { edits: readonly StagedFileEdit[]; result: VerificationResult } | undefined;
  let totalAgentSteps = 0;
  for (let attempt = 1; attempt <= policy.limits.maxAttempts; attempt++) {
    let agentBudgetMs: number;
    try {
      agentBudgetMs = requireTimeBudget(startedAt, policy);
    } catch (error) {
      job = await failJob(ports, job, sanitizeAdapterFailure(error));
      return { status: 'failed', job };
    }
    const agentStepBudget = policy.limits.maxSteps - totalAgentSteps;
    if (agentStepBudget <= 0) {
      job = await failJob(ports, job, 'step-limit');
      return { status: 'failed', job };
    }
    job = await save(ports, job, { status: 'running', stage: 'agent', attempt });
    let output: AgentOutput;
    try {
      const request = buildAgentRequest(
        policy,
        plan,
        source,
        target,
        attempt,
        agentStepBudget,
        agentBudgetMs / 1_000,
        repair,
      );
      assertSerializedSize(request, policy.limits.maxContextBytes, 'context-limit', 'Selected agent packet');
      output = await ports.agent.run(request);
      if (elapsedMs(startedAt) > policy.limits.maxJobSeconds * 1_000) {
        throw new CoreError('job-time-limit', 'Agent exceeded maxJobSeconds');
      }
    } catch (error) {
      job = await failJob(ports, job, sanitizeAdapterFailure(error));
      return { status: 'failed', job };
    }

    let proposalParts: { report: AgentReport; edits: StagedFileEdit[] };
    try {
      proposalParts = validateAgentOutput(output, policy, plan, target, agentStepBudget, agentBudgetMs, globWork);
      requireTimeBudget(startedAt, policy);
    } catch (error) {
      const blocked = error instanceof CoreError && ['agent-blocked', 'protected-edit', 'out-of-scope-edit', 'decision-edit-mismatch'].includes(error.code);
      job = await failJob(ports, job, sanitizeAdapterFailure(error), blocked);
      return { status: blocked ? 'blocked' : 'failed', job };
    }
    totalAgentSteps += output.stepsUsed;
    const stagedProposal = prepareStagedProposal(registration, plan, proposalParts.report, proposalParts.edits);

    if (proposalParts.edits.length === 0) {
      job = await save(ports, job, { status: 'no-op', stage: 'terminal', proposal: stagedProposal, stepsUsed: totalAgentSteps });
      try {
        requireTimeBudget(startedAt, policy);
      } catch (error) {
        job = await failJob(ports, job, sanitizeAdapterFailure(error));
        return { status: 'failed', job };
      }
      if (!await reconcileLastChecked(ports, registration, plan)) throw new CoreError('checkpoint-conflict', 'Could not advance lastCheckedCommit for a skipped-only update');
      return { status: 'no-op', job };
    }

    job = await save(ports, job, {
      status: 'running',
      stage: 'verifying',
      proposal: stagedProposal,
      stepsUsed: totalAgentSteps,
    });
    let result: VerificationResult;
    try {
      const runnerBudgetMs = requireTimeBudget(startedAt, policy);
      const workspaceLimits = DEFAULT_VERIFICATION_WORKSPACE_LIMITS;
      const rawWorkspace = await ports.github.readVerificationWorkspace({
        plan,
        excludedPathPatterns: excludedPathPatterns(policy),
        limits: workspaceLimits,
        maxJobSeconds: Math.max(1, Math.floor(runnerBudgetMs / 1_000)),
      });
      if (elapsedMs(startedAt) > policy.limits.maxJobSeconds * 1_000) {
        throw new CoreError('job-time-limit', 'Verification workspace read exceeded maxJobSeconds');
      }
      const verificationWorkspace = validateVerificationWorkspace(
        rawWorkspace,
        registration,
        plan,
        target,
        policy,
        workspaceLimits,
        globWork,
      );
      requireTimeBudget(startedAt, policy);
      const runnerRequest: RunnerRequest = {
        jobId: plan.jobId,
        plan,
        target,
        verificationWorkspace,
        edits: proposalParts.edits,
        verification: policy.verification,
        maxOutputBytes: policy.limits.maxVerificationOutputBytes,
        maxJobSeconds: policy.limits.maxJobSeconds,
        remainingJobSeconds: runnerBudgetMs / 1_000,
      };
      assertSerializedSize(
        runnerRequest,
        workspaceLimits.maxSerializedBytes + policy.limits.maxContextBytes + policy.limits.maxResponseBytes,
        'context-limit',
        'Verification request',
      );
      const rawResult = await ports.runner.verify(runnerRequest);
      assertSerializedSize(rawResult, policy.limits.maxResponseBytes, 'response-limit', 'Verification response');
      if (elapsedMs(startedAt) > policy.limits.maxJobSeconds * 1_000) {
        throw new CoreError('job-time-limit', 'Runner exceeded maxJobSeconds');
      }
      result = await parseVerificationResult(rawResult, policy, runnerBudgetMs, target, proposalParts.edits);
      requireTimeBudget(startedAt, policy);
    } catch (error) {
      const blocked = error instanceof CoreError && error.code !== 'job-time-limit';
      job = await failJob(ports, job, sanitizeAdapterFailure(error), blocked);
      return { status: job.status === 'blocked' ? 'blocked' : 'failed', job };
    }

    if (result.status === 'passed') {
      const proposal = prepareProposal(registration, plan, proposalParts.report, proposalParts.edits, result);
      job = await save(ports, job, { status: 'ready-to-publish', stage: 'ready-to-publish', proposal });
      try {
        requireTimeBudget(startedAt, policy);
      } catch (error) {
        job = await failJob(ports, job, sanitizeAdapterFailure(error));
        return { status: 'failed', job };
      }
      if (!await reconcileLastChecked(ports, registration, plan)) throw new CoreError('checkpoint-conflict', 'Could not advance lastCheckedCommit for the verified proposal');
      return { status: 'ready-to-publish', job };
    }

    const retryable = result.failureCode !== undefined && RETRYABLE_FAILURES.has(result.failureCode);
    const failedProposal = prepareProposal(registration, plan, proposalParts.report, proposalParts.edits, result);
    if (!retryable || attempt === policy.limits.maxAttempts) {
      job = await save(ports, job, {
        status: 'failed',
        stage: 'terminal',
        proposal: failedProposal,
        failure: { code: `verification-${result.failureCode ?? 'failed'}` },
      });
      return { status: 'failed', job };
    }
    // Persist bounded failure evidence and staged edits before another model call.
    job = await save(ports, job, {
      status: 'running',
      stage: 'agent',
      attempt: attempt + 1,
      proposal: failedProposal,
    });
    repair = { edits: proposalParts.edits, result };
  }

  job = await failJob(ports, job, 'attempt-limit');
  return { status: 'failed', job };
}

function immutableCheckpointCandidate(candidate: CheckpointCandidate): CheckpointCandidate | undefined {
  const candidateFields = [
    'trackingId', 'jobId', 'jobKey', 'upstreamCommit', 'targetBaseCommit', 'policyHash',
    'expectedLastCheckedCommit', 'expectedLastSyncedCommit',
  ] as const;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const fields = new Map<string, string>();
  try {
    const keys = Reflect.ownKeys(candidate);
    if (keys.length !== candidateFields.length
      || keys.some(key => typeof key !== 'string' || !candidateFields.some(field => field === key))) return undefined;
    for (const field of candidateFields) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, field);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
      fields.set(field, descriptor.value);
    }
  } catch {
    return undefined;
  }
  const trackingIdValue = fields.get('trackingId');
  const jobIdValue = fields.get('jobId');
  const jobKeyValue = fields.get('jobKey');
  const upstreamCommitValue = fields.get('upstreamCommit');
  const targetBaseCommitValue = fields.get('targetBaseCommit');
  const policyHashValue = fields.get('policyHash');
  const expectedLastCheckedCommitValue = fields.get('expectedLastCheckedCommit');
  const expectedLastSyncedCommitValue = fields.get('expectedLastSyncedCommit');
  if (trackingIdValue === undefined || jobIdValue === undefined || jobKeyValue === undefined
    || upstreamCommitValue === undefined || targetBaseCommitValue === undefined || policyHashValue === undefined
    || expectedLastCheckedCommitValue === undefined || expectedLastSyncedCommitValue === undefined) return undefined;
  return {
    trackingId: trackingIdValue,
    jobId: jobIdValue,
    jobKey: jobKeyValue,
    upstreamCommit: upstreamCommitValue,
    targetBaseCommit: targetBaseCommitValue,
    policyHash: policyHashValue,
    expectedLastCheckedCommit: expectedLastCheckedCommitValue,
    expectedLastSyncedCommit: expectedLastSyncedCommitValue,
  };
}

async function persistedCheckpointCandidate(
  trackingId: string,
  rawCandidate: CheckpointCandidate,
  store: CorePorts['store'],
): Promise<{ registration: TrackingRegistration; candidate: CheckpointCandidate } | undefined> {
  const supplied = immutableCheckpointCandidate(rawCandidate);
  if (!supplied) return undefined;
  const registration = await store.getTrackingRegistration(trackingId);
  if (!registration || !registration.active || supplied.trackingId !== registration.id
    || supplied.policyHash !== registration.policyHash || !validCommit(supplied.upstreamCommit)
    || !validCommit(supplied.targetBaseCommit) || !validCommit(supplied.expectedLastCheckedCommit)
    || !validCommit(supplied.expectedLastSyncedCommit) || supplied.expectedLastSyncedCommit !== registration.lastSyncedCommit) return undefined;
  const job = await store.getJob(supplied.jobId);
  if (!job || job.trackingId !== registration.id || !job.proposal
    || job.proposal.verification?.status !== 'passed'
    || job.plan.fromCommit !== supplied.expectedLastSyncedCommit
    || job.plan.expectedLastCheckedCommit !== supplied.expectedLastCheckedCommit
    || job.proposal.checkpointCandidate.trackingId !== supplied.trackingId
    || job.proposal.checkpointCandidate.jobId !== supplied.jobId
    || job.proposal.checkpointCandidate.jobKey !== supplied.jobKey
    || job.proposal.checkpointCandidate.upstreamCommit !== supplied.upstreamCommit
    || job.proposal.checkpointCandidate.targetBaseCommit !== supplied.targetBaseCommit
    || job.proposal.checkpointCandidate.policyHash !== supplied.policyHash
    || job.proposal.checkpointCandidate.expectedLastCheckedCommit !== supplied.expectedLastCheckedCommit
    || job.proposal.checkpointCandidate.expectedLastSyncedCommit !== supplied.expectedLastSyncedCommit
    || !['ready-to-publish', 'published'].includes(job.status)) return undefined;
  return { registration, candidate: job.proposal.checkpointCandidate };
}

function observationMatchesCandidate(
  registration: TrackingRegistration,
  candidate: CheckpointCandidate,
  observation: VerifiedMergeObservation,
): boolean {
  return observation.trackingId === registration.id && observation.jobId === candidate.jobId
    && observation.baseBranch === registration.baseBranch
    && observation.upstreamCommit === candidate.upstreamCommit && observation.targetBaseCommit === candidate.targetBaseCommit
    && Number.isSafeInteger(observation.pullRequestNumber) && observation.pullRequestNumber > 0
    && validCommit(observation.mergeCommit) && validCommit(observation.observedBaseCommit)
    && isoDate(observation.observedAt);
}

async function activateWithObservation(
  trackingId: string,
  candidate: CheckpointCandidate,
  observation: VerifiedMergeObservation,
  store: CorePorts['store'],
): Promise<boolean> {
  const persisted = await persistedCheckpointCandidate(trackingId, candidate, store);
  if (!persisted || !observationMatchesCandidate(persisted.registration, persisted.candidate, observation)) return false;
  return store.activateLastSyncedCommit({
    trackingId: persisted.registration.id,
    expectedLastSyncedCommit: persisted.registration.lastSyncedCommit,
    candidate: persisted.candidate,
    merge: observation,
  });
}

/** Applies a GitHub-verified observation returned by the durable-PR lifecycle reader. */
export async function activateConfirmedCheckpoint(
  trackingId: string,
  candidate: CheckpointCandidate,
  observation: VerifiedMergeObservation,
  store: CorePorts['store'],
): Promise<boolean> {
  return activateWithObservation(trackingId, candidate, observation, store);
}

/**
 * Advance only the synchronized checkpoint. The GitHub adapter must prove that this
 * exact candidate was merged into the registration's configured base before storage changes.
 */
export async function activateMergedCheckpoint(
  trackingId: string,
  candidate: CheckpointCandidate,
  ports: Pick<CorePorts, 'store' | 'github'>,
): Promise<boolean> {
  const persisted = await persistedCheckpointCandidate(trackingId, candidate, ports.store);
  if (!persisted) return false;
  const observation = await ports.github.confirmMergedCheckpoint({
    registration: persisted.registration,
    candidate: persisted.candidate,
  });
  if (!observation) return false;
  return activateWithObservation(trackingId, persisted.candidate, observation, ports.store);
}

// Keep these compile-time imports live as exported utility signatures useful to adapters.
export type { AgentReport, PinnedPlan, StagedFileEdit, VerificationResult };
