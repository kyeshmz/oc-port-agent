import { mkdtemp, mkdir, readFile, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG, checkpointPath, protectedEdit, matchesAny, policyHash, type Config, type Verification } from './config.js';
import { RESULT, invokeOpenCode, readReport, writePacket, type AgentReport } from './agent.js';
import { clean, exists, jsonWrite, planSync, type Plan } from './upstream.js';
import { git, run, type CommandResult } from './process.js';
import { publicationGate, publish, type PublishOptions } from './github.js';

export interface VerificationResult extends Verification { code: number; durationMs: number }
export interface SyncOptions {
  full?: boolean;
  model?: string;
  publish?: PublishOptions;
  config?: string;
  // Dependency injection for offline tests, not configurable through untrusted upstream.
  invoke?: (root: string, config: Config, packet: string, failure?: string) => Promise<void>;
}
export interface SyncResult { status: 'up-to-date' | 'proposal'; worktree?: string; branch?: string; report?: string; pr?: string }

export async function changedFiles(root: string): Promise<string[]> {
  const tracked = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD'])).split('\0');
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
}
export function explicitInvocation(text: string): boolean {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header || /<<:|^["'](?:metadata|disable-model-invocation)["']:/m.test(header)) return false;
  const lines = header.split(/\r?\n/);
  const metadata = lines.filter(line => /^metadata:/.test(line));
  const disabled = lines.filter(line => /^disable-model-invocation:/.test(line));
  if (metadata.length > 1 || disabled.length > 1) return false;
  if (metadata.length) {
    if (!/^metadata:\s*$/.test(metadata[0]!)) return false;
    const start = lines.indexOf(metadata[0]!) + 1;
    const block: string[] = [];
    for (const line of lines.slice(start)) {
      if (line && !/^\s|^#/.test(line)) break;
      if (line.trim() && !/^\s*#/.test(line)) block.push(line);
    }
    const indent = Math.min(...block.map(line => /^\s*/.exec(line)![0].length));
    const children = block.filter(line => /^\s*/.exec(line)![0].length === indent);
    if (children.some(line => /^\s*["']/.test(line))) return false;
    const flags = children.filter(line => /^\s*opencode\/autoinvoke:/.test(line));
    if (flags.length) return flags.length === 1 && /^\s*opencode\/autoinvoke:\s*false(?:\s+#.*)?\s*$/.test(flags[0]!);
  }
  return disabled.length === 1 && /^disable-model-invocation:\s*true(?:\s+#.*)?\s*$/.test(disabled[0]!);
}
export async function skillGate(root: string, config: Config): Promise<void> {
  if (config.allowSkillEdits.length) {
    for (const ancestor of ['.opencode', '.opencode/skills']) {
      if (await exists(join(root, ancestor)) && (await lstat(join(root, ancestor))).isSymbolicLink()) throw new Error(`Skill symlink needs manual review: ${ancestor}`);
    }
  }
  const scan = async (path: string, primary: string): Promise<void> => {
    const file = join(root, path);
    if (!await exists(file)) return;
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Skill symlink needs manual review: ${path}`);
    if (stat.isDirectory()) {
      for (const name of await readdir(file)) await scan(`${path}/${name}`, primary);
    } else if (path.endsWith('/SKILL.md')) {
      if (path !== primary) throw new Error(`Nested skill registration is not authorized: ${path}`);
      const text = await readFile(file, 'utf8');
      if (!explicitInvocation(text)) throw new Error(`Updated skill must remain explicitly invoked: ${path}`);
    }
  };
  for (const id of config.allowSkillEdits) await scan(`.opencode/skills/${id}`, `.opencode/skills/${id}/SKILL.md`);
}
export async function editGate(root: string, config: Config, plan: Plan, targetHead: string): Promise<string[]> {
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== targetHead) throw new Error('The agent changed Git history. Refusing to publish or advance the checkpoint.');
  const paths = await changedFiles(root);
  const allowed = plan.selections.flatMap(selection => selection.targetPaths);
  for (const path of paths) {
    if (protectedEdit(path, config) || !matchesAny(path, allowed)) throw new Error(`Out-of-scope or protected edit: ${path}. Worktree preserved for inspection; checkpoint not advanced.`);
    if (await exists(join(root, path))) {
      if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error(`Changed symlink needs manual review: ${path}`);
    }
  }
  await skillGate(root, config);
  return paths;
}

function assertDecisionEdits(report: AgentReport, paths: string[], plan: Plan): void {
  if (paths.length && report.decisions.every(decision => decision.status !== 'applied')) throw new Error('The agent changed files but reported only skipped decisions');
  for (const decision of report.decisions) {
    if (decision.status === 'applied') {
      const selection = plan.selections.find(s => s.id === decision.selection)!;
      if (!paths.some(path => matchesAny(path, selection.targetPaths))) throw new Error(`Selection ${decision.selection} was marked applied without any corresponding target changes`);
    }
  }
}

async function verify(root: string, config: Config): Promise<{ results: VerificationResult[]; failure?: string }> {
  const results: VerificationResult[] = [];
  for (const command of config.verification) {
    const outcome: CommandResult = await run(command.command, command.args, root, command.timeoutSeconds);
    results.push({ ...command, code: outcome.code, durationMs: outcome.durationMs });
    if (outcome.code !== 0) return { results, failure: `${JSON.stringify([command.command, ...command.args])} exited ${outcome.code}.\n${outcome.stdout}\n${outcome.stderr}` };
  }
  return { results };
}

export function prBody(plan: Plan, report: AgentReport, paths: string[], verification: VerificationResult[], reportPath: string): string {
  // Untrusted text is kept in fenced JSON, not interpreted as workflow instructions.
  const details = JSON.stringify({ summary: report.summary, decisions: report.decisions }, null, 2).replace(/`/g, '\\u0060');
  return `## Summary\n\nAdapt selected upstream functionality (${plan.mode}) from \`${plan.from}\` to \`${plan.to}\`.\n\n${paths.length ? `${paths.length} target files changed.` : 'No target implementation changes; checkpoint/report only.'}\n\n## Decisions\n\n\`\`\`json\n${details}\n\`\`\`\n\n## Verification\n\n${verification.map(v => `- ${JSON.stringify([v.command, ...v.args]).replace(/`/g, '\\u0060')} — exit ${v.code}`).join('\n')}\n\nEvidence: \`${reportPath}\`. This draft requires human review; the checkpoint takes effect only when these changes merge.\n`;
}

export async function synchronize(root: string, options: SyncOptions = {}): Promise<SyncResult> {
  await clean(root);
  const { config, state, plan } = await planSync(root, options.full, options.config);
  if (options.model !== undefined) {
    if (!/^[^\s/]+\/[^\s]+$/.test(options.model)) throw new Error('--model must be provider/model, optionally followed by #variant');
    config.opencode.model = options.model;
  }
  if (!options.full && plan.from === plan.to) return { status: 'up-to-date' };
  if (config.selections.some(s => [s.description, ...s.acceptance].some(text => text.includes('EDIT ME:')))) throw new Error(`Replace the scaffold placeholders in ${CONFIG} before invoking OpenCode`);
  const targetHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const namespace = `oc-port/${policyHash(config).slice(0, 12)}/`;
  const branch = `${namespace}${plan.mode}-${plan.to.slice(0, 12)}-${targetHead.slice(0, 8)}`;
  if (options.publish) await publicationGate(root, options.publish, 'oc-port/');
  const parent = await mkdtemp(join(tmpdir(), 'oc-port-agent-'));
  const createdPath = join(parent, 'target');
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, createdPath, targetHead]);
  const worktree = await realpath(createdPath);
  try {
    await skillGate(worktree, config);
    const packet = await writePacket(worktree, config, plan);
    const originalPacket = await readFile(packet, 'utf8');
    let report: AgentReport = { summary: 'No selected upstream paths changed; all configured functionality remains outside this net diff.', decisions: [] };
    let verification: VerificationResult[] = [];
    let paths: string[] = [];
    let failure: string | undefined;
    let passed = false;
    for (let attempt = 1; attempt <= config.opencode.maxAttempts; attempt++) {
      if (plan.selections.length) {
        if (await exists(join(worktree, RESULT))) await unlink(join(worktree, RESULT));
        await (options.invoke ?? invokeOpenCode)(worktree, config, packet, failure);
      }
      // Hard gates are not retried; don't hide forbidden edits behind a later attempt.
      paths = await editGate(worktree, config, plan, targetHead);
      if (await readFile(packet, 'utf8') !== originalPacket) throw new Error('Upstream packet was modified by the agent');
      try {
        if (plan.selections.length) report = await readReport(worktree, plan);
        assertDecisionEdits(report, paths, plan);
      } catch (error) {
        failure = (error as Error).message;
        if (attempt === config.opencode.maxAttempts) throw error;
        continue;
      }
      const checked = await verify(worktree, config);
      verification = checked.results;
      // Trusted verification must not introduce changes outside the allowed scope either.
      paths = await editGate(worktree, config, plan, targetHead);
      if (!checked.failure) { assertDecisionEdits(report, paths, plan); passed = true; break; }
      failure = checked.failure;
      if (!plan.selections.length) break;
    }
    if (!passed) throw new Error(`Verification failed; checkpoint not advanced. ${failure ?? ''}`);
    const reportPath = `.oc-port/reports/${policyHash(config).slice(0, 12)}-${plan.mode}-${plan.to}.json`;
    await mkdir(join(worktree, '.oc-port', 'reports'), { recursive: true });
    await jsonWrite(join(worktree, reportPath), {
      version: 1, upstream: config.upstream, mode: plan.mode,
      from: plan.from, to: plan.to, targetBase: targetHead,
      commits: plan.commits, changedUpstreamPaths: plan.changedPaths, changedTargetPaths: paths,
      report, verification,
      note: 'Agent decisions are claims for human review, not proof of behavioral equivalence. Checkpoint activates when this commit merges.',
    });
    // Only the host writes the next checkpoint, in the proposal branch (not the caller).
    const checkpoint = checkpointPath(config);
    await mkdir(dirname(join(worktree, checkpoint)), { recursive: true });
    await jsonWrite(join(worktree, checkpoint), { ...state, lastSyncedCommit: plan.to });
    await git(worktree, ['add', '--', ...paths, checkpoint, reportPath]);
    const title = `${plan.mode === 'adopt' ? 'Adopt' : 'Sync'} upstream functionality ${plan.to.slice(0, 12)}`;
    await git(worktree, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=oc-port-agent', '-c', 'user.email=oc-port-agent@users.noreply.github.com', 'commit', '-m', title]);
    const result: SyncResult = { status: 'proposal', worktree, branch, report: reportPath };
    if (options.publish) {
      // Recheck after potentially lengthy inference to catch a newly merged base or concurrent sync PR.
      await publicationGate(root, options.publish, 'oc-port/');
      result.pr = await publish(worktree, options.publish, branch, title, prBody(plan, report, paths, verification, reportPath));
    }
    return result;
  } catch (error) {
    throw new Error(`${(error as Error).message}\nProposal worktree preserved: ${worktree}\nBranch: ${branch}`);
  }
}
