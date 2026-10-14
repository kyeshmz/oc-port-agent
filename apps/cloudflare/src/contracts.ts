import type { CloudflarePolicy, SelectionPolicy, VerificationCommand } from './policy.js';

export type CommitSha = string;
export type JobId = string;
export type JobKey = string;
export type TrackingId = string;

export type UpstreamChangeStatus = 'added' | 'modified' | 'deleted';

export interface UpstreamChangedFile {
  path: string;
  status: UpstreamChangeStatus;
}

export interface RepositoryIdentity {
  owner: string;
  name: string;
  /** Canonical `owner/name`; adapters must compare this case-insensitively. */
  fullName: string;
}

export interface TrackingRegistration {
  id: TrackingId;
  installationId: number;
  target: RepositoryIdentity;
  baseBranch: string;
  upstream: { repository: string; ref: string; baselineCommit: CommitSha };
  /** Parsed and validated by the portable core; storage adapters must not reinterpret it. */
  policy: unknown;
  policyHash: string;
  lastCheckedCommit: CommitSha;
  lastSyncedCommit: CommitSha;
  active: boolean;
  revision: number;
}

export interface NewTrackingRegistration {
  id: TrackingId;
  installationId: number;
  target: RepositoryIdentity;
  baseBranch: string;
  upstream: { repository: string; ref: string; baselineCommit: CommitSha };
  policy: unknown;
  policyHash: string;
  active: boolean;
}

export interface WebhookDelivery {
  deliveryId: string;
  installationId: number;
  receivedAt: string;
  expiresAt: string;
}

/** A plan returned by the trusted GitHub read adapter before the core applies policy filters. */
export interface DiscoveredPlan {
  trackingId: TrackingId;
  installationId: number;
  target: RepositoryIdentity;
  baseBranch: string;
  targetBaseCommit: CommitSha;
  upstreamRepository: string;
  upstreamRef: string;
  /** Compare origin is the last verified/merged sync checkpoint. */
  fromCommit: CommitSha;
  /** CAS origin for the poll marker; deliberately independent from `fromCommit`. */
  expectedLastCheckedCommit: CommitSha;
  toCommit: CommitSha;
  commitCount: number;
  /** Complete net file classifications from `fromCommit` through `toCommit`. */
  changedFiles: readonly UpstreamChangedFile[];
  /** Must be the unique path set represented by `changedFiles`. */
  changedPaths: readonly string[];
  /** File paths changed since `expectedLastCheckedCommit`, used only for cheap polling. */
  checkedChangedPaths: readonly string[];
  observedAt: string;
}

/** Immutable, policy-bound plan passed between the core and adapters. */
export interface PinnedPlan extends DiscoveredPlan {
  jobId: JobId;
  jobKey: JobKey;
  policyHash: string;
  selectedUpstreamPaths: readonly string[];
  checkedSelectedUpstreamPaths: readonly string[];
  selectedSelectionIds: readonly string[];
}

export interface SnapshotFile {
  path: string;
  content: string;
  sizeBytes: number;
  /** Symlinks, submodules, and other Git modes are rejected by the snapshot adapter. */
  mode: '100644' | '100755';
}

/** Source content is read only from the exact upstream commit in `plan`. */
export interface SourceSnapshot {
  repository: string;
  beforeCommit: CommitSha;
  /** Prior contents for changed/modified/deleted selected paths only. */
  beforeFiles: readonly SnapshotFile[];
  commit: CommitSha;
  /** Current contents for changed/added/modified selected paths only. */
  files: readonly SnapshotFile[];
  deletedPaths: readonly string[];
}

/** Target content is a materialized, non-executed view of the exact target base. */
export interface TargetSnapshot {
  repository: RepositoryIdentity;
  baseBranch: string;
  commit: CommitSha;
  /** Complete inventory of existing, readable files matching the requested target scopes. */
  existingPaths: readonly string[];
  files: readonly SnapshotFile[];
}

export interface VerificationWorkspaceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxBytes: number;
  maxDirectories: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxSerializedBytes: number;
}

/** Hard cap for the trusted verification tree; intentionally separate from agent context limits. */
export const DEFAULT_VERIFICATION_WORKSPACE_LIMITS: Readonly<VerificationWorkspaceLimits> = Object.freeze({
  maxFiles: 2_000,
  maxFileBytes: 2_000_000,
  maxBytes: 20_000_000,
  maxDirectories: 10_000,
  maxPathBytes: 1_024,
  maxPathDepth: 64,
  maxSerializedBytes: 24_000_000,
});

/** Complete, trusted-host materialization at the pinned target base, never shown to the agent. */
export interface VerificationWorkspaceSnapshot extends TargetSnapshot {
  complete: true;
}

export interface SelectionDecision {
  selection: string;
  status: 'applied' | 'skipped' | 'blocked';
  reason: string;
}

export interface AgentReport {
  summary: string;
  decisions: readonly SelectionDecision[];
}

export interface StagedFileEdit {
  path: string;
  operation: 'write' | 'delete';
  /** Present only for writes. Files are UTF-8 text; mode changes and binary data are unsupported. */
  content?: string;
}

export type VerificationFailureCode =
  | 'command-failed'
  | 'timed-out'
  | 'output-limit'
  | 'forbidden-mutation'
  | 'invalid-workspace'
  | 'cancelled';

export interface VerificationStepResult {
  index: number;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface WorkspaceFileEvidence {
  path: string;
  operation: 'write' | 'delete';
  /** Required for writes; SHA-256 of exact post-verification UTF-8 contents. */
  sha256?: string;
  /** Required for writes; modes are never changed by an agent edit. */
  mode?: '100644' | '100755';
}

/** Intentionally excludes stdout/stderr and includes a complete post-verification workspace diff. */
export interface VerificationResult {
  status: 'passed' | 'failed';
  steps: readonly VerificationStepResult[];
  workspaceFiles: readonly WorkspaceFileEvidence[];
  failureCode?: VerificationFailureCode;
}

export interface CheckpointCandidate {
  trackingId: TrackingId;
  jobId: JobId;
  jobKey: JobKey;
  upstreamCommit: CommitSha;
  targetBaseCommit: CommitSha;
  policyHash: string;
  expectedLastCheckedCommit: CommitSha;
  expectedLastSyncedCommit: CommitSha;
}

export interface JobProposal {
  report: AgentReport;
  edits: readonly StagedFileEdit[];
  /** Absent only while staged edits await host verification. */
  verification?: VerificationResult;
  checkpointCandidate: CheckpointCandidate;
}

export interface VerifiedJobProposal extends JobProposal {
  verification: VerificationResult;
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'ready-to-publish'
  | 'publishing'
  | 'published'
  | 'merged'
  | 'no-op'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type JobStage = 'queued' | 'snapshotting' | 'agent' | 'verifying' | 'ready-to-publish' | 'publishing' | 'terminal';

export interface JobFailure {
  /** Safe, bounded category only. Never store model output, process output, or exception text here. */
  code: string;
}

export interface JobRecord {
  id: JobId;
  key: JobKey;
  trackingId: TrackingId;
  status: JobStatus;
  stage: JobStage;
  version: number;
  attempt: number;
  /** Total accepted agent steps across all attempts for this job. */
  stepsUsed: number;
  plan: PinnedPlan;
  proposal?: JobProposal;
  failure?: JobFailure;
  createdAt: string;
  updatedAt: string;
}

export type NewJobRecord = Omit<JobRecord, 'status' | 'stage' | 'version' | 'attempt' | 'createdAt' | 'updatedAt'>;

export interface AgentRepairContext {
  priorEdits: readonly StagedFileEdit[];
  failureCode: 'command-failed';
  failedStepIndices: readonly number[];
}

export interface AgentRequest {
  jobId: JobId;
  plan: PinnedPlan;
  source: SourceSnapshot;
  target: TargetSnapshot;
  selections: readonly SelectionPolicy[];
  preserve: readonly string[];
  attempt: number;
  maxAttempts: number;
  maxSteps: number;
  maxJobSeconds: number;
  remainingJobSeconds: number;
  maxResponseBytes: number;
  maxFileBytes: number;
  repair?: AgentRepairContext;
}

/** Adapter output is treated as unknown at runtime and validated by `core.ts`. */
export interface AgentOutput {
  report: unknown;
  edits: unknown;
  stepsUsed: number;
  durationMs: number;
}

export interface RunnerRequest {
  jobId: JobId;
  plan: PinnedPlan;
  /** Narrow target snapshot visible to the agent. */
  target: TargetSnapshot;
  /** Full bounded host-only workspace used only by the isolated verifier. */
  verificationWorkspace: VerificationWorkspaceSnapshot;
  edits: readonly StagedFileEdit[];
  verification: readonly VerificationCommand[];
  maxOutputBytes: number;
  maxJobSeconds: number;
  /** Remaining end-to-end job budget after snapshot and model time. */
  remainingJobSeconds: number;
}

export interface DraftPublicationRequest {
  registration: TrackingRegistration;
  plan: PinnedPlan;
  proposal: VerifiedJobProposal;
  /** Stable idempotency key; adapters must recover an existing matching draft rather than duplicate it. */
  idempotencyKey: JobKey;
}

export interface DraftPublication {
  pullRequestNumber: number;
  url: string;
  headCommit: CommitSha;
}

export interface VerifiedMergeObservation {
  trackingId: TrackingId;
  jobId: JobId;
  pullRequestNumber: number;
  baseBranch: string;
  upstreamCommit: CommitSha;
  targetBaseCommit: CommitSha;
  /** Current configured-base head observed to contain `mergeCommit`. */
  observedBaseCommit: CommitSha;
  mergeCommit: CommitSha;
  observedAt: string;
}

export type PullRequestLifecycle =
  | { status: 'open'; pullRequestNumber: number; observedAt: string }
  | { status: 'closed-unmerged'; pullRequestNumber: number; observedAt: string }
  | { status: 'merged'; observation: VerifiedMergeObservation }
  | { status: 'unknown'; retryAfterSeconds?: number };

export interface CumulativeRangeQuery {
  trackingId: TrackingId;
  fromCommit: CommitSha;
  toCommit: CommitSha;
  policyHash: string;
  limit: number;
}

export interface CumulativeRangeJobs {
  jobs: readonly JobRecord[];
  more: boolean;
}

export interface SyncOriginQuery {
  trackingId: TrackingId;
  fromCommit: CommitSha;
  policyHash: string;
  limit: number;
}

export interface CheckedCommitAdvance {
  trackingId: TrackingId;
  expectedLastCheckedCommit: CommitSha;
  nextLastCheckedCommit: CommitSha;
  policyHash: string;
}

export interface SyncedCommitActivation {
  trackingId: TrackingId;
  expectedLastSyncedCommit: CommitSha;
  candidate: CheckpointCandidate;
  merge: VerifiedMergeObservation;
}

/** Compare-and-swap methods must be durable and idempotent on duplicate delivery. */
export interface StorePort {
  /** Conflicting duplicate IDs must fail; registration never silently replaces operator-approved policy. */
  createTrackingRegistration(input: NewTrackingRegistration): Promise<TrackingRegistration>;
  getTrackingRegistration(trackingId: TrackingId): Promise<TrackingRegistration | undefined>;
  listActiveTrackingRegistrations(input: { limit: number; cursor?: string }): Promise<{
    registrations: readonly TrackingRegistration[];
    nextCursor?: string;
  }>;
  /** CAS used for suspend/uninstall/repository-removal reconciliation. */
  setTrackingRegistrationActive(input: { trackingId: TrackingId; expectedRevision: number; active: boolean }): Promise<boolean>;
  /** Atomic replay guard keyed by the exact GitHub delivery ID and installation. */
  recordWebhookDelivery(input: WebhookDelivery): Promise<boolean>;
  createOrGetJob(input: NewJobRecord): Promise<{ job: JobRecord; created: boolean }>;
  getJob(jobId: JobId): Promise<JobRecord | undefined>;
  getJobByKey(jobKey: JobKey): Promise<JobRecord | undefined>;
  /** Bounded logical range lookup used to stop target-base churn from creating unlimited generations. */
  listJobsForCumulativeRange(input: CumulativeRangeQuery): Promise<CumulativeRangeJobs>;
  /** Bounded prior-job lookup for a synchronized origin when the checked poll delta is irrelevant. */
  listJobsForSyncOrigin(input: SyncOriginQuery): Promise<CumulativeRangeJobs>;
  /** Persist `record` only when the stored version equals `expectedVersion`, then return the stored record. */
  saveJob(record: JobRecord, expectedVersion: number): Promise<JobRecord>;
  /** Updates only lastCheckedCommit; must not mutate lastSyncedCommit. Idempotent if already at `next`. */
  advanceLastCheckedCommit(input: CheckedCommitAdvance): Promise<boolean>;
  /** Updates only lastSyncedCommit after a verified merge; must enforce the expected-checkpoint CAS. */
  activateLastSyncedCommit(input: SyncedCommitActivation): Promise<boolean>;
}

export interface GitHubPort {
  /** Registration preflight: target must belong to the installation; private upstreams require installation read access. */
  verifyTrackingAccess(input: {
    installationId: number;
    target: RepositoryIdentity;
    upstreamRepository: string;
  }): Promise<{ targetAccessible: boolean; targetWritable: boolean; upstreamReadable: boolean }>;
  /** Bounded GitHub-only compare/read; returns undefined when there is no new upstream commit. */
  discoverPlan(registration: TrackingRegistration, policy: CloudflarePolicy): Promise<DiscoveredPlan | undefined>;
  readSourceSnapshot(input: {
    plan: PinnedPlan;
    paths: readonly string[];
    maxFiles: number;
    maxFileBytes: number;
    maxBytes: number;
    maxJobSeconds: number;
  }): Promise<SourceSnapshot>;
  readVerificationWorkspace(input: {
    plan: PinnedPlan;
    excludedPathPatterns: readonly string[];
    limits: VerificationWorkspaceLimits;
    maxJobSeconds: number;
  }): Promise<VerificationWorkspaceSnapshot>;
  readTargetSnapshot(input: {
    plan: PinnedPlan;
    pathPatterns: readonly string[];
    excludedPathPatterns: readonly string[];
    maxFiles: number;
    maxFileBytes: number;
    maxBytes: number;
    maxJobSeconds: number;
  }): Promise<TargetSnapshot>;
  /** Creates or recovers one draft for this idempotency key; never merges or force-updates a branch. */
  publishDraft(input: DraftPublicationRequest): Promise<DraftPublication>;
  /** Returns an observation only after confirming the PR merge is present on the configured base. */
  confirmMergedCheckpoint(input: {
    registration: TrackingRegistration;
    candidate: CheckpointCandidate;
  }): Promise<VerifiedMergeObservation | undefined>;
  /** Read-only lifecycle lookup by the durable PR number; ambiguity is retryable, never closure. */
  getPullRequestLifecycle(input: {
    registration: TrackingRegistration;
    candidate: CheckpointCandidate;
    pullRequestNumber: number;
  }): Promise<PullRequestLifecycle>;
}

/** The agent adapter has no shell, network, Git, publication, or credential-bearing inputs. */
export interface AgentPort {
  run(input: AgentRequest): Promise<AgentOutput>;
}

/** Verification is host-controlled, argv-based, and isolated; no credentials are supplied. */
export interface RunnerPort {
  verify(input: RunnerRequest): Promise<VerificationResult>;
}

export interface CorePorts {
  store: StorePort;
  github: GitHubPort;
  agent: AgentPort;
  runner: RunnerPort;
  now?: () => string;
}

export type JobRunResult =
  | { status: 'up-to-date' }
  | { status: 'irrelevant'; checkedThrough: CommitSha }
  | { status: 'in-progress'; job: JobRecord }
  | { status: 'ready-to-publish'; job: JobRecord }
  | { status: 'no-op'; job: JobRecord }
  | { status: 'blocked'; job: JobRecord }
  | { status: 'failed'; job: JobRecord }
  | { status: 'terminal'; job: JobRecord };
