import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CONFIG, STATE } from '../src/config.js';
import { git, run } from '../src/process.js';
import { initialize, jsonWrite, planSync, setBaseline } from '../src/upstream.js';
import { synchronize, type SyncOptions } from '../src/sync.js';

export const DEFAULT_MODEL = 'openai/gpt-6-luna#max';
export const PINNED_REF = 'public-pinned';
const MAX_ATTEMPTS = 2;
const MAX_STEPS = 30;
const ATTEMPT_TIMEOUT_SECONDS = 300;
const CONTEXT_LIMIT_BYTES = 250_000;

export type PublicCaseId = 'escape-string-regexp' | 'strip-bom';

export interface PublicCase {
  id: PublicCaseId;
  publicUrl: string;
  pinnedCommit: string;
  sourcePath: string;
  implementationPath: string;
  helperPath: string;
  testPath: string;
  description: string;
  acceptance: string[];
  verification: { command: string; args: string[] };
}

export const PUBLIC_CASES: readonly PublicCase[] = [
  {
    id: 'escape-string-regexp',
    publicUrl: 'https://github.com/sindresorhus/escape-string-regexp.git',
    pinnedCommit: 'a7f7dabaf336bda98d2166848af15d9168b10bcf',
    sourcePath: 'index.js',
    implementationPath: 'src/regex_port.py',
    helperPath: 'src/target_helpers.py',
    testPath: 'test/test_regex_port.py',
    description: 'Port literal regular-expression escaping to Python while preserving the target-only helper API.',
    acceptance: [
      'Escape the upstream-supported regular-expression metacharacters as literals and encode hyphen as \\x2d.',
      'Reject non-string inputs with TypeError.',
      'Keep the target-only local_namespace helper unchanged.',
    ],
    verification: {
      command: 'python3',
      args: ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'],
    },
  },
  {
    id: 'strip-bom',
    publicUrl: 'https://github.com/sindresorhus/strip-bom.git',
    pinnedCommit: 'c691ec5724be8bb61e9df269a2577fcba41353f7',
    sourcePath: 'index.js',
    implementationPath: 'src/strip-prefix.js',
    helperPath: 'src/target-helpers.js',
    testPath: 'test/strip-prefix.test.mjs',
    description: 'Adopt leading-BOM stripping in the target’s differently named JavaScript API and preserve its local helper.',
    acceptance: [
      'Remove exactly one leading U+FEFF and preserve interior or repeated subsequent BOMs.',
      'Preserve all other string contents and reject non-string inputs with TypeError.',
      'Keep the target-only localTag helper unchanged.',
    ],
    verification: {
      command: process.execPath,
      args: ['--test', 'test/strip-prefix.test.mjs'],
    },
  },
];

export interface CliOptions {
  live: boolean;
  help: boolean;
  model: string;
  cases: PublicCaseId[];
}

export interface CommandEvidence {
  name: string;
  command: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  expected: 'pass' | 'fail';
  matchedExpectation: boolean;
}

export interface CaseEvidence {
  caseId: PublicCaseId;
  status: 'not-run' | 'running' | 'passed' | 'failed';
  publicUrl: string;
  sourceRepository: string;
  sourceKind: 'public-upstream' | 'offline-test-fixture';
  pinnedCommit: string;
  model: string;
  bounds: { maxAttempts: number; maxSteps: number; timeoutSeconds: number; contextLimitBytes: number };
  upstreamSnapshot: string;
  targetPath: string;
  evidencePath: string;
  startedAt: string;
  durationMs?: number;
  currentStage?: string;
  failureStage?: string;
  failureKind?: string;
  proposalPath?: string;
  proposalBranch?: string;
  mergedTargetHead?: string;
  stages: {
    pinnedCommitVerified: boolean;
    sourceContextPreviewed: boolean;
    initialBehaviorFailed: boolean;
    successfulProposalValidated: boolean;
    callerPreservedBeforeMerge: boolean;
    proposalOraclePassed: boolean;
    disposableTargetMerged: boolean;
    mergedOraclePassed: boolean;
    unchangedUpstreamNoOp: boolean;
  };
  sourceContext?: {
    path: string;
    sha256: string;
    bytes: number;
    selectionId: string;
    upstreamRepository: string;
    upstreamRef: string;
    planMode: string;
    planFrom: string;
    planTo: string;
    selection: {
      id: string;
      description: string;
      upstreamPaths: string[];
      targetPaths: string[];
      acceptance: string[];
    };
  };
  fixedHashes?: Record<string, string>;
  checks: CommandEvidence[];
  hostVerification?: { command: string; args: string[]; exitCode: number; durationMs: number }[];
  scopeCheck?: { changedTargetPaths: string[]; proposalFiles: string[]; unexpectedFiles: string[] };
  preservationCheck?: {
    targetHeadBefore: string;
    targetHeadAfterSync: string;
    targetImplementationSha256Before: string;
    targetImplementationSha256AfterSync: string;
    targetCheckpointSha256Before: string;
    targetCheckpointSha256AfterSync: string;
    fixedHashesMatchProposal: boolean;
    unchangedBeforeMerge: boolean;
  };
  noOpStatus?: string;
}

export interface SuiteEvidence {
  version: 1;
  status: 'running' | 'passed' | 'failed';
  model: string;
  bounds: { maxAttempts: number; maxSteps: number; timeoutSeconds: number; contextLimitBytes: number };
  artifactRoot: string;
  evidencePath: string;
  startedAt: string;
  updatedAt: string;
  selectedCases: PublicCaseId[];
  preflight: CommandEvidence[];
  cases: Record<PublicCaseId, CaseEvidence>;
  failureStage?: string;
  failureKind?: string;
}

export interface RunCaseOptions {
  sourceRepository: string;
  pinnedCommit?: string;
  artifactsRoot: string;
  evidencePath: string;
  model: string;
  live?: boolean;
  // This injection exists for local offline regression tests only.
  invoke?: SyncOptions['invoke'];
  onProgress?: (evidence: CaseEvidence) => Promise<void> | void;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function fileHash(root: string, path: string): Promise<string> {
  return sha256(await readFile(join(root, path)));
}

function isoNow(): string {
  return new Date().toISOString();
}

function isModel(value: string): boolean {
  return /^[^/\s]+\/[^#\s]+(?:#[^\s]+)?$/.test(value);
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { live: false, help: false, model: DEFAULT_MODEL, cases: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--live') {
      options.live = true;
    } else if (arg === '--model') {
      const model = args[++index];
      if (!model || model.startsWith('--')) throw new Error('--model requires provider/model with an optional #variant');
      if (!isModel(model)) throw new Error('--model must be provider/model with an optional #variant');
      options.model = model;
    } else if (arg === '--case') {
      const name = args[++index];
      if (!name || name.startsWith('--')) throw new Error('--case requires a case name');
      if (!PUBLIC_CASES.some(item => item.id === name)) throw new Error(`Unknown case: ${name}`);
      const id = name as PublicCaseId;
      if (!options.cases.includes(id)) options.cases.push(id);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.help && args.some(arg => arg !== '--help' && arg !== '-h')) throw new Error('--help cannot be combined with other options');
  if (!options.cases.length) options.cases = PUBLIC_CASES.map(item => item.id);
  return options;
}

export function helpText(): string {
  return [
    'Usage: npm run test:public -- --live [options]',
    '',
    'Opt-in public-upstream adoption tests. Without --live, no repository is fetched and no model is called.',
    '',
    'Options:',
    `  --live                         Allow public fetches and real model calls`,
    `  --model provider/model#variant Model to use (default ${DEFAULT_MODEL})`,
    `  --case <name>                  Select a case; repeat to select multiple`,
    `  --help                         Show this help`,
    '',
    `Cases: ${PUBLIC_CASES.map(item => item.id).join(', ')}`,
    'Artifacts and disposable target repositories are retained under the system temporary directory.',
  ].join('\n');
}

async function persistCase(evidence: CaseEvidence, options: RunCaseOptions): Promise<void> {
  evidence.durationMs = Date.now() - Date.parse(evidence.startedAt);
  await mkdir(dirname(options.evidencePath), { recursive: true });
  await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await options.onProgress?.(evidence);
}

async function commandCheck(
  evidence: CaseEvidence,
  name: string,
  command: string,
  args: string[],
  cwd: string,
  expected: 'pass' | 'fail',
  timeoutSeconds = 120,
): Promise<boolean> {
  const outcome = await run(command, args, cwd, timeoutSeconds);
  const matchedExpectation = expected === 'pass' ? outcome.code === 0 : outcome.code !== 0;
  evidence.checks.push({ name, command, args, exitCode: outcome.code, durationMs: outcome.durationMs, expected, matchedExpectation });
  return matchedExpectation;
}

async function cloneAndFreeze(source: string, destination: string, commit: string, evidence: CaseEvidence): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const args = ['clone', '--bare', '--no-tags', source, destination];
  const clone = await run('git', args, dirname(destination), 300, {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  });
  evidence.checks.push({ name: 'bare-clone-upstream', command: 'git', args, exitCode: clone.code, durationMs: clone.durationMs, expected: 'pass', matchedExpectation: clone.code === 0 });
  if (clone.code !== 0) throw new Error('bare-clone-failed');
  await git(destination, ['cat-file', '-e', `${commit}^{commit}`]);
  await git(destination, ['update-ref', `refs/heads/${PINNED_REF}`, commit]);
  await git(destination, ['symbolic-ref', 'HEAD', `refs/heads/${PINNED_REF}`]);
  if ((await git(destination, ['rev-parse', `refs/heads/${PINNED_REF}^{commit}`])).trim() !== commit) {
    throw new Error('pinned-ref-mismatch');
  }
}

async function writeFixedFixture(target: string, item: PublicCase, url: string, commit: string, licenseText: string): Promise<void> {
  const implementation = join(target, item.implementationPath);
  const helper = join(target, item.helperPath);
  const testPath = join(target, item.testPath);
  await mkdir(dirname(implementation), { recursive: true });
  await mkdir(dirname(helper), { recursive: true });
  await mkdir(dirname(testPath), { recursive: true });

  if (item.id === 'escape-string-regexp') {
    await writeFile(implementation, [
      'def escape_regex(value):',
      '    # Deliberately incomplete starting behavior for the adoption test.',
      '    return value',
      '',
    ].join('\n'), { flag: 'wx' });
    await writeFile(helper, [
      'def local_namespace(value):',
      '    return f"target:{value}"',
      '',
    ].join('\n'), { flag: 'wx' });
    await writeFile(testPath, pythonAcceptanceTests, { flag: 'wx' });
  } else {
    await writeFile(implementation, [
      'export function removePrefixBom(value) {',
      '  // Deliberately wrong: removes interior/repeated BOMs and accepts invalid values.',
      "  return typeof value === 'string' ? value.replace(/\\uFEFF/g, '') : value;",
      '}',
      '',
    ].join('\n'), { flag: 'wx' });
    await writeFile(helper, [
      'export function localTag(value) {',
      '  return `target:${value}`;',
      '}',
      '',
    ].join('\n'), { flag: 'wx' });
    await writeFile(testPath, javascriptAcceptanceTests, { flag: 'wx' });
  }

  const attribution = [
    `Reference repository: ${url}`,
    `Pinned commit: ${commit}`,
    'This repository is a disposable local fixture; no upstream source was checked out or executed.',
    licenseText ? 'The following upstream license text was copied verbatim from the pinned bare snapshot:' : 'No license file was found in the pinned snapshot; review upstream licensing before any use outside this disposable fixture.',
    '',
    licenseText,
  ].filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n');
  await writeFile(join(target, 'UPSTREAM-ATTRIBUTION.txt'), `${attribution.trimEnd()}\n`, { flag: 'wx' });
}

async function findLicense(snapshot: string, commit: string): Promise<string> {
  const names = (await git(snapshot, ['ls-tree', '-r', '--name-only', commit])).split('\n').filter(Boolean);
  const licensePath = names.find(name => /(^|\/)licen[cs]e(?:\.[^/]*)?$/i.test(name));
  return licensePath ? git(snapshot, ['show', `${commit}:${licensePath}`]) : '';
}

function configuration(item: PublicCase, snapshot: string, model: string): Record<string, unknown> {
  return {
    version: 1,
    upstream: { repository: snapshot, ref: PINNED_REF },
    selections: [{
      id: item.id,
      description: item.description,
      upstreamPaths: [item.sourcePath],
      excludeUpstreamPaths: [],
      targetPaths: [item.implementationPath],
      acceptance: item.acceptance,
      mappings: [{ upstream: item.sourcePath, target: [item.implementationPath] }],
    }],
    preserve: ['Do not edit the fixed acceptance tests, target helper, fixture configuration, or checkpoint.', 'Preserve the target-specific helper API.'],
    verification: [{ command: item.verification.command, args: item.verification.args, timeoutSeconds: 120 }],
    opencode: { model, timeoutSeconds: ATTEMPT_TIMEOUT_SECONDS, maxAttempts: MAX_ATTEMPTS, steps: MAX_STEPS },
    limits: { maxCommits: 100, maxContextBytes: CONTEXT_LIMIT_BYTES },
  };
}

function safeFailureKind(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('live-opt-in-required')) return 'live-opt-in-required';
    if (message.includes('git-unavailable')) return 'git-unavailable';
    if (message.includes('python3-unavailable')) return 'python3-unavailable';
    if (message.includes('node-unavailable')) return 'node-unavailable';
    if (message.includes('opencode cli-unavailable')) return 'opencode-cli-unavailable';
    if (message.includes('bare-clone-failed')) return 'public-bare-clone-failed';
    if (message.includes('pinned-ref-mismatch') || message.includes('git cat-file')) return 'pinned-commit-unavailable';
    if (message.includes('verification failed')) return 'host-verification-failed';
    if (message.includes('opencode failed') || message.includes('opencode emitted')) return 'opencode-call-failed';
    if (message.includes('out-of-scope') || message.includes('protected edit') || message.includes('edit scope')) return 'edit-scope-gate-failed';
    return error.name || 'Error';
  }
  return 'UnknownError';
}

function proposalFromError(error: unknown): { path?: string; branch?: string } {
  if (!(error instanceof Error)) return {};
  const path = error.message.match(/Proposal worktree preserved: ([^\n]+)/)?.[1];
  const branch = error.message.match(/Branch: ([^\n]+)/)?.[1];
  return {
    ...(path ? { path } : {}),
    ...(branch ? { branch } : {}),
  };
}

function acceptanceFixtureFiles(item: PublicCase): string[] {
  return [item.testPath, item.helperPath, CONFIG, 'UPSTREAM-ATTRIBUTION.txt'];
}

const pythonAcceptanceTests = `import itertools
import re
import unittest

from src.regex_port import escape_regex
from src.target_helpers import local_namespace


SPECIAL = set(r"|\\{}()[ ]^$+*?.".replace(" ", ""))


def expected_literal(value):
    pieces = []
    for character in value:
        if character == "-":
            pieces.append(r"\\x2d")
        elif character in SPECIAL:
            pieces.append(chr(92) + character)
        else:
            pieces.append(character)
    return "".join(pieces)


class EscapeRegexAcceptanceTests(unittest.TestCase):
    def test_all_regex_specials_hyphen_and_backslash_have_exact_escaping(self):
        value = r"|\\{}()[ ]^$+*?.-".replace(" ", "")
        self.assertEqual(escape_regex(value), expected_literal(value))
        self.assertEqual(escape_regex("a-b"), r"a\\x2db")
        self.assertEqual(escape_regex(chr(92)), chr(92) * 2)

    def test_fixed_and_exhaustive_strings_match_only_their_literal_value(self):
        alphabet = [".", "*", "-", chr(92), "|", "a", "é", chr(0xFEFF)]
        samples = ["", "plain", "-", "\\\\", "é", "\\ufeff", "a\\ufeffb"]
        for length in range(4):
            samples.extend("".join(chars) for chars in itertools.product(alphabet, repeat=length))
        for value in samples:
            with self.subTest(value=value):
                escaped = escape_regex(value)
                self.assertEqual(escaped, expected_literal(value))
                self.assertIsNotNone(re.fullmatch(escaped, value))

    def test_invalid_inputs_are_rejected(self):
        for value in (None, 3, [], object()):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    escape_regex(value)

    def test_target_only_helper_is_preserved(self):
        self.assertEqual(local_namespace("case"), "target:case")


if __name__ == "__main__":
    unittest.main()
`;

const javascriptAcceptanceTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { removePrefixBom } from '../src/strip-prefix.js';
import { localTag } from '../src/target-helpers.js';

test('removes exactly one leading BOM and preserves all other contents', () => {
  const cases = [
    ['', ''],
    ['plain', 'plain'],
    ['\\uFEFFtext', 'text'],
    ['\\uFEFF\\uFEFFtext', '\\uFEFFtext'],
    ['a\\uFEFFb', 'a\\uFEFFb'],
    ['\\\\server\\\\path', '\\\\server\\\\path'],
    ['é雪🙂', 'é雪🙂'],
    ['\\uFEFF', ''],
  ];
  for (const [input, expected] of cases) assert.equal(removePrefixBom(input), expected);
});

test('rejects non-string inputs', () => {
  for (const input of [null, undefined, 3, {}, []]) {
    assert.throws(() => removePrefixBom(input), TypeError);
  }
});

test('preserves the target-only helper API', () => {
  assert.equal(localTag('case'), 'target:case');
});
`;

export async function runPublicRepositoryCase(item: PublicCase, options: RunCaseOptions): Promise<CaseEvidence> {
  const started = Date.now();
  const pinnedCommit = options.pinnedCommit ?? item.pinnedCommit;
  const target = join(options.artifactsRoot, 'target');
  const snapshot = join(options.artifactsRoot, 'upstream.git');
  const evidence: CaseEvidence = {
    caseId: item.id,
    status: 'running',
    publicUrl: item.publicUrl,
    sourceRepository: options.sourceRepository,
    sourceKind: options.live ? 'public-upstream' : 'offline-test-fixture',
    pinnedCommit,
    model: options.model,
    bounds: { maxAttempts: MAX_ATTEMPTS, maxSteps: MAX_STEPS, timeoutSeconds: ATTEMPT_TIMEOUT_SECONDS, contextLimitBytes: CONTEXT_LIMIT_BYTES },
    upstreamSnapshot: snapshot,
    targetPath: target,
    evidencePath: options.evidencePath,
    startedAt: isoNow(),
    currentStage: 'opt-in',
    stages: {
      pinnedCommitVerified: false,
      sourceContextPreviewed: false,
      initialBehaviorFailed: false,
      successfulProposalValidated: false,
      callerPreservedBeforeMerge: false,
      proposalOraclePassed: false,
      disposableTargetMerged: false,
      mergedOraclePassed: false,
      unchangedUpstreamNoOp: false,
    },
    checks: [],
  };
  let stage = 'opt-in';
  const persist = async (): Promise<void> => persistCase(evidence, options);
  const markStage = async (next: string): Promise<void> => {
    stage = next;
    evidence.currentStage = next;
    await persist();
  };
  const checkpointHashPath = STATE;

  await mkdir(options.artifactsRoot, { recursive: true });
  await persist();
  try {
    if (!options.live && !options.invoke) throw new Error('live-opt-in-required');

    await markStage('git-preflight');
    if (!await commandCheck(evidence, 'git-version', 'git', ['--version'], options.artifactsRoot, 'pass', 30)) throw new Error('git-unavailable');

    await markStage(item.id === 'escape-string-regexp' ? 'python-preflight' : 'node-preflight');
    const runtimeCommand = item.id === 'escape-string-regexp' ? 'python3' : process.execPath;
    if (!await commandCheck(evidence, `${item.id === 'escape-string-regexp' ? 'python3' : 'node'}-version`, runtimeCommand, ['--version'], options.artifactsRoot, 'pass', 30)) {
      throw new Error(item.id === 'escape-string-regexp' ? 'python3-unavailable' : 'node-unavailable');
    }

    await markStage('bare-clone-and-pin');
    await cloneAndFreeze(options.sourceRepository, snapshot, pinnedCommit, evidence);
    evidence.stages.pinnedCommitVerified = true;
    const sourceText = await git(snapshot, ['show', `${pinnedCommit}:${item.sourcePath}`]);
    const licenseText = await findLicense(snapshot, pinnedCommit);
    evidence.sourceContext = {
      path: item.sourcePath,
      sha256: sha256(sourceText),
      bytes: Buffer.byteLength(sourceText),
      selectionId: item.id,
      upstreamRepository: snapshot,
      upstreamRef: PINNED_REF,
      planMode: 'adopt',
      planFrom: pinnedCommit,
      planTo: pinnedCommit,
      selection: {
        id: item.id,
        description: item.description,
        upstreamPaths: [item.sourcePath],
        targetPaths: [item.implementationPath],
        acceptance: item.acceptance,
      },
    };
    await persist();

    await markStage('target-fixture');
    await mkdir(target, { recursive: true });
    await git(target, ['init', '-b', 'main']);
    await git(target, ['config', 'user.name', 'oc-port public test fixture']);
    await git(target, ['config', 'user.email', 'oc-port-public-test@users.noreply.github.com']);
    await git(target, ['config', 'commit.gpgsign', 'false']);
    await git(target, ['config', 'core.hooksPath', '/dev/null']);
    await writeFixedFixture(target, item, options.sourceRepository, pinnedCommit, licenseText);
    await initialize(target, snapshot, PINNED_REF);
    await jsonWrite(join(target, CONFIG), configuration(item, snapshot, options.model));
    await setBaseline(target, pinnedCommit);
    await git(target, ['add', '-A']);
    await git(target, ['commit', '-m', `Create disposable ${item.id} target fixture`]);

    await markStage('initial-oracle');
    const fixedHashes: Record<string, string> = {};
    for (const path of acceptanceFixtureFiles(item)) fixedHashes[path] = await fileHash(target, path);
    evidence.fixedHashes = fixedHashes;
    const targetHeadBefore = (await git(target, ['rev-parse', 'HEAD'])).trim();
    const implementationSha256Before = await fileHash(target, item.implementationPath);
    const checkpointSha256Before = await fileHash(target, checkpointHashPath);
    const initialFailed = await commandCheck(evidence, 'initial-acceptance-oracle', item.verification.command, item.verification.args, target, 'fail', 120);
    if (!initialFailed) throw new Error('initial-acceptance-tests-did-not-fail');
    evidence.stages.initialBehaviorFailed = true;

    await markStage('full-adoption-preview');
    const preview = await planSync(target, true);
    if (preview.plan.mode !== 'adopt' || preview.plan.to !== pinnedCommit || !preview.plan.selections.some(selection => selection.id === item.id)
      || !preview.plan.after.some(file => file.path === item.sourcePath)) throw new Error('full-adoption-preview-mismatch');
    evidence.stages.sourceContextPreviewed = true;
    evidence.sourceContext = {
      ...evidence.sourceContext!,
      planMode: preview.plan.mode,
      planFrom: preview.plan.from,
      planTo: preview.plan.to,
      selectionId: preview.plan.selections[0]!.id,
      selection: {
        id: preview.plan.selections[0]!.id,
        description: preview.plan.selections[0]!.description,
        upstreamPaths: preview.plan.selections[0]!.upstreamPaths,
        targetPaths: preview.plan.selections[0]!.targetPaths,
        acceptance: preview.plan.selections[0]!.acceptance,
      },
    };
    await persist();

    await markStage('synchronize');
    const syncStarted = Date.now();
    let proposal;
    try {
      const syncOptions: SyncOptions = options.invoke
        ? { full: true, model: options.model, invoke: options.invoke }
        : { full: true, model: options.model };
      proposal = await synchronize(target, syncOptions);
    } catch (error) {
      const createdProposal = proposalFromError(error);
      if (createdProposal.path) evidence.proposalPath = createdProposal.path;
      if (createdProposal.branch) evidence.proposalBranch = createdProposal.branch;
      throw error;
    }
    evidence.checks.push({
      name: 'synchronize-full-adoption', command: 'oc-port-agent:synchronize', args: ['--full', '--model', options.model],
      exitCode: 0, durationMs: Date.now() - syncStarted, expected: 'pass', matchedExpectation: true,
    });
    if (proposal.status !== 'proposal' || !proposal.worktree || !proposal.branch || !proposal.report) throw new Error('no-verified-proposal-created');
    evidence.proposalPath = proposal.worktree;
    evidence.proposalBranch = proposal.branch;

    await markStage('proposal-validation');
    const report = JSON.parse(await readFile(join(proposal.worktree, proposal.report), 'utf8')) as {
      upstream?: { repository?: string; ref?: string };
      from?: string;
      to?: string;
      changedTargetPaths?: string[];
      report?: { decisions?: { selection: string; status: string; reason: string }[] };
      verification?: { command: string; args: string[]; code: number; durationMs: number }[];
    };
    const decisions = report.report?.decisions ?? [];
    if (report.upstream?.repository !== snapshot || report.upstream.ref !== PINNED_REF || report.from !== pinnedCommit || report.to !== pinnedCommit) {
      throw new Error('proposal-pinned-provenance-mismatch');
    }
    if (decisions.length !== 1 || decisions[0]!.selection !== item.id || decisions[0]!.status !== 'applied' || !decisions[0]!.reason.trim()) {
      throw new Error('proposal-decision-incomplete-or-not-applied');
    }
    const changedTargetPaths = report.changedTargetPaths ?? [];
    if (!changedTargetPaths.includes(item.implementationPath) || changedTargetPaths.some(path => path !== item.implementationPath)) {
      throw new Error('proposal-does-not-contain-only-the-implementation-edit');
    }
    const hostVerification = report.verification ?? [];
    if (!hostVerification.length || hostVerification.some(check => check.code !== 0)) throw new Error('host-verification-did-not-pass');
    evidence.hostVerification = hostVerification.map(check => ({ command: check.command, args: check.args, exitCode: check.code, durationMs: check.durationMs }));

    const proposalHead = (await git(proposal.worktree, ['rev-parse', 'HEAD'])).trim();
    const proposalParent = (await git(proposal.worktree, ['rev-parse', `${proposalHead}^`])).trim();
    if (proposalParent !== targetHeadBefore) throw new Error('proposal-parent-does-not-match-disposable-target');
    const proposalFiles = (await git(target, ['diff', '--name-only', targetHeadBefore, proposalHead])).split('\n').filter(Boolean);
    const allowedProposalFiles = new Set([item.implementationPath, STATE, proposal.report]);
    const unexpectedFiles = proposalFiles.filter(path => !allowedProposalFiles.has(path));
    evidence.scopeCheck = { changedTargetPaths, proposalFiles, unexpectedFiles };
    if (unexpectedFiles.length || (await git(proposal.worktree, ['status', '--porcelain'])).trim()) throw new Error('proposal-has-unexpected-or-uncommitted-files');

    const proposalImplementationHash = await fileHash(proposal.worktree, item.implementationPath);
    if (proposalImplementationHash === implementationSha256Before) throw new Error('proposal-implementation-was-not-changed');
    // File reads are asynchronous; compare explicitly so the trusted files cannot be silently weakened.
    let allFixedHashesMatch = true;
    for (const [path, hash] of Object.entries(fixedHashes)) {
      if (await fileHash(proposal.worktree, path) !== hash) allFixedHashesMatch = false;
    }
    const targetHeadAfterSync = (await git(target, ['rev-parse', 'HEAD'])).trim();
    const implementationSha256AfterSync = await fileHash(target, item.implementationPath);
    const checkpointSha256AfterSync = await fileHash(target, checkpointHashPath);
    const unchangedBeforeMerge = targetHeadAfterSync === targetHeadBefore
      && implementationSha256AfterSync === implementationSha256Before
      && checkpointSha256AfterSync === checkpointSha256Before
      && allFixedHashesMatch;
    evidence.preservationCheck = {
      targetHeadBefore, targetHeadAfterSync,
      targetImplementationSha256Before: implementationSha256Before,
      targetImplementationSha256AfterSync: implementationSha256AfterSync,
      targetCheckpointSha256Before: checkpointSha256Before,
      targetCheckpointSha256AfterSync: checkpointSha256AfterSync,
      fixedHashesMatchProposal: allFixedHashesMatch,
      unchangedBeforeMerge,
    };
    if (!unchangedBeforeMerge) throw new Error('caller-target-or-protected-file-changed-before-merge');
    evidence.stages.callerPreservedBeforeMerge = true;
    evidence.stages.successfulProposalValidated = true;

    await markStage('proposal-oracle');
    if (!await commandCheck(evidence, 'independent-proposal-oracle', item.verification.command, item.verification.args, proposal.worktree, 'pass', 120)) {
      throw new Error('proposal-oracle-failed');
    }
    evidence.stages.proposalOraclePassed = true;
    let fixedHashesStillMatch = true;
    for (const [path, hash] of Object.entries(fixedHashes)) {
      if (await fileHash(proposal.worktree, path) !== hash) fixedHashesStillMatch = false;
    }
    if (!fixedHashesStillMatch || (await git(proposal.worktree, ['status', '--porcelain'])).trim()) {
      throw new Error('proposal-changed-files-during-independent-verification');
    }
    await persist();

    await markStage('local-fixture-fast-forward');
    const mergeArgs = ['merge', '--ff-only', proposal.branch];
    const mergeStarted = Date.now();
    const mergeResult = await run('git', mergeArgs, target, 120);
    evidence.checks.push({
      name: 'disposable-target-fast-forward', command: 'git', args: mergeArgs, exitCode: mergeResult.code,
      durationMs: mergeResult.durationMs || Date.now() - mergeStarted, expected: 'pass', matchedExpectation: mergeResult.code === 0,
    });
    if (mergeResult.code !== 0) throw new Error('disposable-target-fast-forward-failed');
    evidence.stages.disposableTargetMerged = true;
    evidence.mergedTargetHead = (await git(target, ['rev-parse', 'HEAD'])).trim();
    if (evidence.mergedTargetHead !== proposalHead) throw new Error('fixture-fast-forward-head-mismatch');

    await markStage('merged-oracle');
    if (!await commandCheck(evidence, 'merged-target-oracle', item.verification.command, item.verification.args, target, 'pass', 120)) {
      throw new Error('merged-target-oracle-failed');
    }
    evidence.stages.mergedOraclePassed = true;

    await markStage('unchanged-upstream-no-op');
    let noOpInvokeCalled = false;
    const noOpStarted = Date.now();
    const noOp = await synchronize(target, {
      invoke: async () => {
        noOpInvokeCalled = true;
        throw new Error('No-op synchronization must not invoke a model');
      },
    });
    evidence.checks.push({
      name: 'unchanged-upstream-sync', command: 'oc-port-agent:synchronize', args: [], exitCode: 0,
      durationMs: Date.now() - noOpStarted, expected: 'pass', matchedExpectation: noOp.status === 'up-to-date',
    });
    evidence.noOpStatus = noOp.status;
    if (noOp.status !== 'up-to-date' || noOpInvokeCalled) throw new Error('unchanged-upstream-sync-was-not-a-model-free-no-op');
    evidence.stages.unchangedUpstreamNoOp = true;

    await markStage('final-fixed-hashes');
    let fixedHashesMatchTarget = true;
    for (const [path, hash] of Object.entries(fixedHashes)) {
      if (await fileHash(target, path) !== hash) fixedHashesMatchTarget = false;
    }
    if (!fixedHashesMatchTarget) throw new Error('fixed-test-helper-or-config-hash-changed');
    evidence.status = 'passed';
    evidence.currentStage = 'complete';
    await persist();
  } catch (error) {
    evidence.status = 'failed';
    evidence.currentStage = stage;
    evidence.failureStage = stage;
    evidence.failureKind = safeFailureKind(error);
    const createdProposal = proposalFromError(error);
    if (createdProposal.path) evidence.proposalPath = createdProposal.path;
    if (createdProposal.branch) evidence.proposalBranch = createdProposal.branch;
    await persist();
  }
  evidence.durationMs = Date.now() - started;
  await persist();
  return evidence;
}

async function requireCommand(
  command: string,
  args: string[],
  label: string,
  cwd: string,
  suite: SuiteEvidence,
  persist: () => Promise<void>,
): Promise<void> {
  const result = await run(command, args, cwd, 30);
  suite.preflight.push({
    name: `${label}-version`, command, args, exitCode: result.code, durationMs: result.durationMs,
    expected: 'pass', matchedExpectation: result.code === 0,
  });
  await persist();
  if (result.code !== 0) throw new Error(`${label}-unavailable`);
}

export interface RunSuiteOptions {
  live: boolean;
  model?: string;
  cases?: PublicCaseId[];
  artifactsRoot?: string;
  // Test-only injection. Live CLI calls deliberately omit this and use synchronize's real default adapter.
  invoke?: SyncOptions['invoke'];
}

export async function runPublicRepositoryTests(options: RunSuiteOptions): Promise<SuiteEvidence> {
  if (!options.live) return runPublicRepositoryTestsInApprovedTemp(options);
  const previousTmpdir = process.env.TMPDIR;
  const approvedTemp = process.env.OC_PORT_PUBLIC_TMPDIR
    ? resolve(process.env.OC_PORT_PUBLIC_TMPDIR)
    : join(tmpdir(), 'opencode');
  await mkdir(approvedTemp, { recursive: true });
  process.env.TMPDIR = approvedTemp;
  try {
    return await runPublicRepositoryTestsInApprovedTemp(options);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
}

async function runPublicRepositoryTestsInApprovedTemp(options: RunSuiteOptions): Promise<SuiteEvidence> {
  const model = options.model ?? DEFAULT_MODEL;
  if (!isModel(model)) throw new Error('Model must be provider/model with an optional #variant');
  const selected = options.cases ?? PUBLIC_CASES.map(item => item.id);
  for (const id of selected) if (!PUBLIC_CASES.some(item => item.id === id)) throw new Error(`Unknown case: ${id}`);
  if (!options.live && !options.invoke) throw new Error('Public repository work requires --live; no network or model work was started');

  const artifactRoot = options.artifactsRoot ?? await createArtifactRoot();
  await mkdir(artifactRoot, { recursive: true });
  const evidencePath = join(artifactRoot, 'evidence', 'combined.json');
  const cases = {} as Record<PublicCaseId, CaseEvidence>;
  for (const item of PUBLIC_CASES) {
    cases[item.id] = {
      caseId: item.id,
      status: 'not-run',
      publicUrl: item.publicUrl,
      sourceRepository: item.publicUrl,
      sourceKind: 'public-upstream',
      pinnedCommit: item.pinnedCommit,
      model,
      bounds: { maxAttempts: MAX_ATTEMPTS, maxSteps: MAX_STEPS, timeoutSeconds: ATTEMPT_TIMEOUT_SECONDS, contextLimitBytes: CONTEXT_LIMIT_BYTES },
      upstreamSnapshot: join(artifactRoot, item.id, 'upstream.git'),
      targetPath: join(artifactRoot, item.id, 'target'),
      evidencePath: join(artifactRoot, 'evidence', `${item.id}.json`),
      startedAt: isoNow(),
      currentStage: 'not-run',
      stages: {
        pinnedCommitVerified: false, sourceContextPreviewed: false, initialBehaviorFailed: false,
        successfulProposalValidated: false, callerPreservedBeforeMerge: false, proposalOraclePassed: false,
        disposableTargetMerged: false, mergedOraclePassed: false, unchangedUpstreamNoOp: false,
      },
      checks: [],
    };
  }
  const suite: SuiteEvidence = {
    version: 1,
    status: 'running',
    model,
    bounds: { maxAttempts: MAX_ATTEMPTS, maxSteps: MAX_STEPS, timeoutSeconds: ATTEMPT_TIMEOUT_SECONDS, contextLimitBytes: CONTEXT_LIMIT_BYTES },
    artifactRoot,
    evidencePath,
    startedAt: isoNow(),
    updatedAt: isoNow(),
    selectedCases: [...selected],
    preflight: [],
    cases,
  };
  const persistSuite = async (): Promise<void> => {
    suite.updatedAt = isoNow();
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
  };
  await persistSuite();

  try {
    const cwd = artifactRoot;
    await requireCommand('git', ['--version'], 'git', cwd, suite, persistSuite);
    if (selected.includes('escape-string-regexp')) await requireCommand('python3', ['--version'], 'python3', cwd, suite, persistSuite);
    await requireCommand('opencode', ['--version'], 'OpenCode CLI', cwd, suite, persistSuite);
  } catch (error) {
    suite.status = 'failed';
    suite.failureStage = 'preflight';
    suite.failureKind = safeFailureKind(error);
    for (const id of selected) {
      suite.cases[id].status = 'failed';
      suite.cases[id].failureStage = 'preflight';
      suite.cases[id].failureKind = safeFailureKind(error);
      suite.cases[id].currentStage = 'preflight';
      await mkdir(dirname(suite.cases[id].evidencePath), { recursive: true });
      await writeFile(suite.cases[id].evidencePath, `${JSON.stringify(suite.cases[id], null, 2)}\n`, 'utf8');
    }
    await persistSuite();
    return suite;
  }

  for (const id of selected) {
    const item = PUBLIC_CASES.find(candidate => candidate.id === id)!;
    const caseRoot = join(artifactRoot, id);
    const caseEvidencePath = join(artifactRoot, 'evidence', `${id}.json`);
    const evidence = await runPublicRepositoryCase(item, {
      sourceRepository: item.publicUrl,
      artifactsRoot: caseRoot,
      evidencePath: caseEvidencePath,
      model,
      live: options.live,
      ...(options.invoke ? { invoke: options.invoke } : {}),
      onProgress: async partial => {
        suite.cases[id] = partial;
        await persistSuite();
      },
    });
    suite.cases[id] = evidence;
    await persistSuite();
  }
  suite.status = selected.every(id => suite.cases[id].status === 'passed') ? 'passed' : 'failed';
  await persistSuite();
  return suite;
}

async function createArtifactRoot(): Promise<string> {
  const approvedTemp = process.env.OC_PORT_PUBLIC_TMPDIR
    ? resolve(process.env.OC_PORT_PUBLIC_TMPDIR)
    : process.env.TMPDIR ? resolve(process.env.TMPDIR) : join(tmpdir(), 'opencode');
  await mkdir(approvedTemp, { recursive: true });
  return mkdtemp(join(approvedTemp, 'oc-port-public-repositories-'));
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments');
    console.error(`Run with --help for usage. Live network/model work requires --live.`);
    return 2;
  }
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (!options.live) {
    console.error('Public repository tests are opt-in. Pass --live to allow public fetches and real model calls.');
    return 2;
  }

  const suite = await runPublicRepositoryTests({ live: true, model: options.model, cases: options.cases });
  console.log(`Public repository harness ${suite.status}.`);
  console.log(`Evidence: ${suite.evidencePath}`);
  if (suite.failureKind) console.error(`Failure: ${suite.failureKind}`);
  for (const id of suite.selectedCases) {
    const result = suite.cases[id];
    console.log(`${id}: ${result.status}${result.failureStage ? ` (${result.failureStage})` : ''}${result.failureKind ? ` [${result.failureKind}]` : ''}`);
  }
  return suite.status === 'passed' ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.name : 'UnexpectedError');
    process.exitCode = 1;
  });
}
