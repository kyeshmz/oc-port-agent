import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, upstreamSource, type Config, type UpstreamTracking } from './config.js';
import { exists, fetchUpstream, jsonWrite, planSource, type Plan } from './upstream.js';
import { adaptSource, type Adaptation, type SyncOptions } from './sync.js';
import { git, mustRun, run } from './process.js';

// A hub is one repository that ports upstream changes into many target repositories:
//   ports/<name>/target.json          the target repository, base branch and verification commands
//   ports/<name>/upstreams/<id>.json  one upstream: what to follow, which parts we use, how we differ
//   ports/<name>/notes.md             free-form context handed to the agent with every change
//   ports/<name>/state.json           written by the hub: synced releases, open PR, history
//   STATUS.md                         written by the hub: one table for every port
export const PORTS = 'ports';
export const STATUS = 'STATUS.md';
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const RUNNER = /^[a-z0-9][a-z0-9.-]*$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_NOTES = 64 * 1024;
const MAX_HISTORY = 20;
// A failing change is attempted on two runs; after that it waits for a new release or an edited port.
const MAX_FAILURES = 2;

export interface SetupCommand { command: string; args: string[]; timeoutSeconds: number }
// runner is the GitHub Actions runner for porting (e.g. macos-15); setup runs on it before the agent.
export interface Target { repository: string; base: string; draft: boolean; runner: string; setup: SetupCommand[] }
export interface PortSource { id: string; start?: string; config: Config }
export interface Port { name: string; directory: string; target: Target; sources: PortSource[]; notes: string }

type Decision = Adaptation['report']['decisions'][number];
interface Checkpoint { lastSyncedCommit: string; release?: string; selectionsHash: string; syncedAt: string }
interface PendingSource { from: string; to: string; release?: string; selectionsHash: string; decisions?: Decision[] }
interface HistoryEntry { at: string; outcome: 'merged' | 'closed' | 'skipped' | 'baselined'; pr?: string; sources: Record<string, { to: string; release?: string; decisions?: Decision[] }> }
export type PortStatus = 'up-to-date' | 'proposal' | 'waiting' | 'skipped' | 'queued' | 'error';
export interface PortState {
  version: 1;
  upstreams: Record<string, Checkpoint>;
  declined: Record<string, { to: string; release?: string }>;
  pending?: { number: number; url: string; branch: string; openedAt: string; sources: Record<string, PendingSource> };
  failed?: { key: string; count: number; at: string; message: string };
  lastRun?: { at: string; status: PortStatus; message?: string; latest: Record<string, { to: string; release?: string }> };
  history: HistoryEntry[];
}
export interface PortOutcome { port: string; status: PortStatus; message?: string; pr?: string }

export interface PullRequestSummary { number: number; url: string; head: string; body: string }
export interface HubGitHub {
  clone(repository: string, base: string, directory: string): Promise<void>;
  openPullRequests(repository: string): Promise<PullRequestSummary[]>;
  pullRequest(repository: string, number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; url: string }>;
  createPullRequest(request: { repository: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
}
// reconcileOnly records PR outcomes and checkpoints but leaves porting to a run on the port's own runner.
export interface HubOptions { port?: string; model?: string; reconcileOnly?: boolean; github?: HubGitHub; invoke?: SyncOptions['invoke']; now?: () => Date }

// Uses gh's authentication (GH_TOKEN in CI). git reaches GitHub through `gh auth setup-git`.
export const ghHub: HubGitHub = {
  async clone(repository, base, directory) {
    const result = await run('git', ['clone', '--no-tags', '--single-branch', '--branch', base, `https://github.com/${repository}.git`, directory], tmpdir(), 600, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
    if (result.code !== 0) throw new Error(`Cannot clone ${repository} (${base}): ${result.stderr.trim()}`);
  },
  async openPullRequests(repository) {
    const pages = JSON.parse(await mustRun('gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls?state=open&per_page=100`], tmpdir())) as { number: number; html_url: string; head: { ref: string }; body: string | null }[][];
    return pages.flat().map(pr => ({ number: pr.number, url: pr.html_url, head: pr.head.ref, body: pr.body ?? '' }));
  },
  async pullRequest(repository, number) {
    const pr = JSON.parse(await mustRun('gh', ['api', `repos/${repository}/pulls/${number}`], tmpdir())) as { state: 'open' | 'closed'; merged: boolean; html_url: string };
    return { state: pr.state, merged: Boolean(pr.merged), url: pr.html_url };
  },
  async createPullRequest({ repository, base, head, title, body, draft }) {
    const directory = await mkdtemp(join(tmpdir(), 'oc-port-pr-'));
    try {
      await writeFile(join(directory, 'body.md'), body);
      const pr = JSON.parse(await mustRun('gh', ['api', '-X', 'POST', `repos/${repository}/pulls`, '-f', `title=${title}`, '-f', `head=${head}`, '-f', `base=${base}`, '-F', `draft=${draft}`, '-F', `body=@${join(directory, 'body.md')}`], directory)) as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
};

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be a JSON object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field in ${where}: ${key}`);
}
async function readJson(path: string, where: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`${where}: ${(error as Error).message}`); }
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Widening or changing selections means earlier upstream code may be missing, so the next sync re-adopts.
const selectionsHash = (config: Config): string => hash({ upstream: upstreamSource(config), selections: config.selections });
const label = (plan: { to: string; release?: string }): string => plan.release ?? plan.to.slice(0, 12);
const oneLine = (text: string, limit: number): string => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > limit ? `${line.slice(0, limit - 1)}…` : line; };

export async function listPorts(hub: string): Promise<string[]> {
  if (!await exists(join(hub, PORTS))) return [];
  const names: string[] = [];
  for (const name of (await readdir(join(hub, PORTS))).sort()) {
    const stat = await lstat(join(hub, PORTS, name));
    if (stat.isDirectory() && !stat.isSymbolicLink() && !name.startsWith('.')) names.push(name);
  }
  return names;
}

export async function loadPort(hub: string, name: string): Promise<Port> {
  if (!NAME.test(name)) throw new Error(`Port folder names must be lowercase, like my-app: ${name}`);
  const directory = join(hub, PORTS, name);
  const raw = object(await readJson(join(directory, 'target.json'), `ports/${name}/target.json`), `ports/${name}/target.json`);
  keys(raw, ['$schema', 'version', 'repository', 'base', 'draft', 'runner', 'setup', 'verification', 'protectedPaths', 'opencode'], `ports/${name}/target.json`);
  if (raw.version !== 1) throw new Error(`ports/${name}/target.json: version must be 1`);
  if (typeof raw.repository !== 'string' || !REPOSITORY.test(raw.repository)) throw new Error(`ports/${name}/target.json: repository must be owner/name`);
  const base = raw.base ?? 'main';
  if (typeof base !== 'string' || !BRANCH.test(base) || base.includes('..') || base.startsWith('/') || base.endsWith('/')) throw new Error(`ports/${name}/target.json: base must be a branch name`);
  if (raw.draft !== undefined && typeof raw.draft !== 'boolean') throw new Error(`ports/${name}/target.json: draft must be true or false`);
  const runner = raw.runner ?? 'ubuntu-latest';
  if (typeof runner !== 'string' || !RUNNER.test(runner)) throw new Error(`ports/${name}/target.json: runner must be a GitHub Actions runner label like ubuntu-latest or macos-15`);
  if (raw.setup !== undefined && !Array.isArray(raw.setup)) throw new Error(`ports/${name}/target.json: setup must be a list of commands`);
  const setup = ((raw.setup ?? []) as unknown[]).map((entry, index): SetupCommand => {
    const where = `ports/${name}/target.json setup[${index}]`;
    const command = object(entry, where);
    keys(command, ['command', 'args', 'timeoutSeconds'], where);
    if (typeof command.command !== 'string' || !command.command.trim() || command.command.startsWith('-')) throw new Error(`${where}: command must be an executable name`);
    if (!Array.isArray(command.args ?? []) || (command.args as unknown[] ?? []).some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error(`${where}: args must be a list of strings`);
    const timeout = command.timeoutSeconds ?? 600;
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600) throw new Error(`${where}: timeoutSeconds must be between 1 and 3600`);
    return { command: command.command, args: (command.args ?? []) as string[], timeoutSeconds: timeout as number };
  });
  const upstreams = join(directory, 'upstreams');
  const files = await exists(upstreams) ? (await readdir(upstreams)).filter(file => file.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error(`ports/${name}: add at least one upstreams/<id>.json`);
  const sources = await Promise.all(files.map(async (file): Promise<PortSource> => {
    const id = file.slice(0, -'.json'.length);
    const where = `ports/${name}/upstreams/${file}`;
    if (!NAME.test(id)) throw new Error(`${where}: file names must be lowercase, like main-library.json`);
    const source = object(await readJson(join(upstreams, file), where), where);
    keys(source, ['$schema', 'upstream', 'start', 'selections', 'preserve', 'limits', 'allowSkillEdits', 'allowNulTextPaths', 'reviewMetadataPaths'], where);
    if (source.start !== undefined && (typeof source.start !== 'string' || !(['latest', 'adopt'].includes(source.start) || SHA.test(source.start)))) {
      throw new Error(`${where}: start must be a full upstream commit SHA the target already matches, "latest", or "adopt"`);
    }
    try {
      const config = parseConfig({
        version: 1, upstream: source.upstream, selections: source.selections, preserve: source.preserve ?? [],
        verification: raw.verification,
        ...(raw.protectedPaths !== undefined ? { protectedPaths: raw.protectedPaths } : {}),
        ...(raw.opencode !== undefined ? { opencode: raw.opencode } : {}),
        ...(source.limits !== undefined ? { limits: source.limits } : {}),
        ...(source.allowSkillEdits !== undefined ? { allowSkillEdits: source.allowSkillEdits } : {}),
        ...(source.allowNulTextPaths !== undefined ? { allowNulTextPaths: source.allowNulTextPaths } : {}),
        ...(source.reviewMetadataPaths !== undefined ? { reviewMetadataPaths: source.reviewMetadataPaths } : {}),
      });
      return { id, ...(source.start !== undefined ? { start: source.start as string } : {}), config };
    } catch (error) { throw new Error(`${where}: ${(error as Error).message}`); }
  }));
  const notesPath = join(directory, 'notes.md');
  const notes = await exists(notesPath) ? await readFile(notesPath, 'utf8') : '';
  if (Buffer.byteLength(notes) > MAX_NOTES) throw new Error(`ports/${name}/notes.md is larger than ${MAX_NOTES} bytes`);
  return { name, directory, target: { repository: raw.repository, base, draft: raw.draft ?? true, runner, setup }, sources, notes };
}

export async function readState(directory: string): Promise<PortState> {
  const path = join(directory, 'state.json');
  if (!await exists(path)) return { version: 1, upstreams: {}, declined: {}, history: [] };
  const raw = object(await readJson(path, 'state.json'), 'state.json');
  if (raw.version !== 1) throw new Error(`${path}: unsupported state version`);
  return { ...raw, upstreams: object(raw.upstreams ?? {}, 'state.upstreams'), declined: object(raw.declined ?? {}, 'state.declined'), history: Array.isArray(raw.history) ? raw.history : [] } as PortState;
}
async function writeState(directory: string, state: PortState): Promise<void> {
  state.history = state.history.slice(-MAX_HISTORY);
  await jsonWrite(join(directory, 'state.json'), state);
}

// notes.md plus the recent outcomes, so the agent knows what was merged, skipped or rejected before.
export function agentNotes(port: Port, state: PortState): string {
  const parts = port.notes.trim() ? [port.notes.trim()] : [];
  const recent = state.history.slice(-5);
  if (recent.length) {
    parts.push(`## Earlier sync outcomes (recorded by the hub; decisions are earlier agent claims, for reference)\n${recent.map(entry => {
      const sources = Object.entries(entry.sources).map(([id, source]) => {
        const decisions = (source.decisions ?? []).map(d => `${d.selection} ${d.status}: ${oneLine(d.reason, 300)}`).join('; ');
        return `${id} ${label(source)}${decisions ? ` (${decisions})` : ''}`;
      }).join(', ');
      return `- ${entry.at.slice(0, 10)} ${entry.outcome}${entry.pr ? ` ${entry.pr}` : ''}: ${sources}`;
    }).join('\n')}`);
  }
  return parts.join('\n\n');
}

const MARKER = /<!-- oc-port-hub (\{[^\n]*?\}) -->/;
function marker(port: string, sources: Record<string, PendingSource>): string {
  const slim = Object.fromEntries(Object.entries(sources).map(([id, { from, to, release, selectionsHash }]) => [id, { from, to, ...(release ? { release } : {}), selectionsHash }]));
  return `<!-- oc-port-hub ${JSON.stringify({ port, sources: slim })} -->`;
}
function parseMarker(body: string): { port: string; sources: Record<string, PendingSource> } | undefined {
  const match = MARKER.exec(body);
  if (!match) return undefined;
  try {
    const value = object(JSON.parse(match[1]!), 'marker');
    const sources = object(value.sources, 'marker.sources') as Record<string, PendingSource>;
    if (typeof value.port !== 'string' || Object.values(sources).some(s => !SHA.test(String(s?.to)) || !SHA.test(String(s?.from)) || typeof s.selectionsHash !== 'string')) return undefined;
    return { port: value.port, sources };
  } catch { return undefined; }
}

function placeholders(port: Port): string | undefined {
  for (const source of port.sources) {
    const texts = source.config.selections.flatMap(s => [s.description, ...s.acceptance]);
    if (texts.some(text => text.includes('EDIT ME:'))) return `Replace the EDIT ME placeholders in ports/${port.name}/upstreams/${source.id}.json`;
  }
  return undefined;
}

interface Work { source: PortSource; plan: Plan; selectionsHash: string }
interface Result extends Work { adaptation: Adaptation }

function pullRequestBody(port: Port, results: Result[], sources: Record<string, PendingSource>): string {
  const sections = results.map(({ source, plan, adaptation }) => {
    const details = JSON.stringify({ summary: adaptation.report.summary, decisions: adaptation.report.decisions }, null, 2).replace(/`/g, '\\u0060');
    const checks = adaptation.verification.map(v => `- ${JSON.stringify([v.command, ...v.args]).replace(/`/g, '\\u0060')}: exit ${v.code}`).join('\n');
    return `### ${source.id}: ${plan.mode === 'adopt' ? 'adopt' : 'sync'} ${source.config.upstream.repository}\n\n\`${plan.from.slice(0, 12)}\` → ${plan.release ? `release \`${plan.release}\`` : `\`${plan.to.slice(0, 12)}\``}, ${plan.commits.length} upstream commits, ${adaptation.paths.length} target files changed.\n\n\`\`\`json\n${details.length > 20000 ? `${details.slice(0, 20000)}\n…truncated` : details}\n\`\`\`\n\n${checks}`;
  });
  return `${marker(port.name, sources)}\n## Upstream changes from the port hub\n\nPort \`${port.name}\`. All verification commands passed in the final tree.\n\n${sections.join('\n\n')}\n\n---\nMerge to record these upstream changes as synced. Close to skip them; the hub then waits for the next upstream release.\n`.slice(0, 60000);
}

async function runPort(hub: string, port: Port, state: PortState, options: HubOptions): Promise<PortOutcome> {
  const github = options.github ?? ghHub;
  const repository = port.target.repository;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const latest: Record<string, { to: string; release?: string }> = {};
  const finish = (status: PortStatus, extra: { message?: string; pr?: string } = {}): PortOutcome => {
    state.lastRun = { at, status, ...(extra.message ? { message: extra.message } : {}), latest };
    return { port: port.name, status, ...extra };
  };
  const checkpoint = (id: string, to: string, release: string | undefined, digest: string): void => {
    state.upstreams[id] = { lastSyncedCommit: to, ...(release ? { release } : {}), selectionsHash: digest, syncedAt: at };
  };
  const problem = placeholders(port);
  if (problem) throw new Error(problem);

  // 1. Find out what happened to the PR from an earlier run.
  if (state.pending) {
    const pending = state.pending;
    const pr = await github.pullRequest(repository, pending.number);
    if (pr.state === 'open') {
      for (const [id, source] of Object.entries(pending.sources)) latest[id] = { to: source.to, ...(source.release ? { release: source.release } : {}) };
      return finish('waiting', { pr: pr.url, message: `Waiting for review: ${pr.url}` });
    }
    for (const [id, source] of Object.entries(pending.sources)) {
      if (pr.merged) { checkpoint(id, source.to, source.release, source.selectionsHash); delete state.declined[id]; }
      else state.declined[id] = { to: source.to, ...(source.release ? { release: source.release } : {}) };
    }
    state.history.push({ at, outcome: pr.merged ? 'merged' : 'closed', pr: pr.url, sources: Object.fromEntries(Object.entries(pending.sources).map(([id, s]) => [id, { to: s.to, ...(s.release ? { release: s.release } : {}), ...(s.decisions ? { decisions: s.decisions } : {}) }])) });
    delete state.pending;
  } else {
    const open = (await github.openPullRequests(repository)).find(pr => pr.head.startsWith('oc-port/'));
    if (open) {
      const recorded = parseMarker(open.body);
      if (recorded?.port !== port.name) throw new Error(`Another oc-port PR is open in ${repository}: ${open.url}. Merge or close it first.`);
      // The PR exists but an earlier run could not record it (for example, the state commit failed).
      state.pending = { number: open.number, url: open.url, branch: open.head, openedAt: at, sources: recorded.sources };
      return finish('waiting', { pr: open.url, message: `Waiting for review: ${open.url}` });
    }
  }

  // 2. Work out what is new upstream, without calling a model.
  const work: Work[] = [];
  for (const source of port.sources) {
    const digest = selectionsHash(source.config);
    const recorded = state.upstreams[source.id];
    let from: string;
    let full = false;
    if (recorded) {
      from = recorded.lastSyncedCommit;
      full = recorded.selectionsHash !== digest;
    } else {
      if (!source.start) throw new Error(`ports/${port.name}/upstreams/${source.id}.json needs "start": a commit the target already matches, "latest", or "adopt"`);
      if (SHA.test(source.start)) {
        // The target already matches this commit, so it is the first checkpoint. From now on state.json wins.
        from = source.start;
        checkpoint(source.id, from, undefined, digest);
      } else {
        const { head, release } = await fetchUpstream(hub, source.config);
        if (source.start === 'latest') {
          checkpoint(source.id, head, release, digest);
          latest[source.id] = { to: head, ...(release ? { release } : {}) };
          state.history.push({ at, outcome: 'baselined', sources: { [source.id]: { to: head, ...(release ? { release } : {}) } } });
          continue;
        }
        from = head;
        full = true;
      }
    }
    const plan = await planSource(hub, source.config, from, full);
    latest[source.id] = { to: plan.to, ...(plan.release ? { release: plan.release } : {}) };
    if (!full && plan.from === plan.to) continue;
    if (!full && state.declined[source.id]?.to === plan.to) continue;
    // Upstream changed only files this target does not use.
    if (!plan.selections.length) { checkpoint(source.id, plan.to, plan.release, digest); continue; }
    work.push({ source, plan, selectionsHash: digest });
  }
  if (!work.length) { delete state.failed; return finish('up-to-date'); }

  const key = hash({ work: work.map(w => [w.source.id, w.plan.from, w.plan.to, w.plan.mode]), configs: work.map(w => w.source.config), notes: port.notes });
  if (state.failed?.key === key && state.failed.count >= MAX_FAILURES) {
    return finish('error', { message: `Stopped after ${state.failed.count} failed attempts at these upstream changes. Edit ports/${port.name} to try again, or wait for a new upstream release. Last error: ${state.failed.message}` });
  }
  if (options.reconcileOnly) return finish('queued', { message: `New upstream changes; they are ported on ${port.target.runner}.` });

  // 3. Port everything new into one fresh clone of the target, and open one PR.
  const scratch = await mkdtemp(join(tmpdir(), 'oc-port-hub-'));
  // Only failures that cost model calls count toward MAX_FAILURES; a missing App install doesn't.
  let invoked = false;
  try {
    const root = join(scratch, 'target');
    await github.clone(repository, port.target.base, root);
    // Agent scratch files stay out of the change set even if the target does not ignore them.
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await appendFile(join(root, '.git', 'info', 'exclude'), '\n.oc-port/\n');
    for (const step of port.target.setup) {
      // Toolchain setup runs beside the clone, so it can't add files to the change set.
      const result = await run(step.command, step.args, scratch, step.timeoutSeconds);
      if (result.code !== 0) throw new Error(`Setup ${JSON.stringify([step.command, ...step.args])} exited ${result.code}: ${oneLine(result.stderr || result.stdout, 1500)}`);
    }
    const notes = agentNotes(port, state);
    const results: Result[] = [];
    for (const item of work) {
      invoked = true;
      const adaptation = await adaptSource(root, { ...item.source.config, ...(notes ? { notes } : {}) }, item.plan, options.invoke);
      if (adaptation.paths.length) {
        await git(root, ['add', '--', ...adaptation.paths]);
        await git(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=oc-port-agent', '-c', 'user.email=oc-port-agent@users.noreply.github.com', 'commit', '-m', `Port ${item.source.id} ${label(item.plan)}`]);
      }
      results.push({ ...item, adaptation });
    }
    const sources: Record<string, PendingSource> = Object.fromEntries(results.map(r => [r.source.id, { from: r.plan.from, to: r.plan.to, ...(r.plan.release ? { release: r.plan.release } : {}), selectionsHash: r.selectionsHash, decisions: r.adaptation.report.decisions }]));
    delete state.failed;
    if (!results.some(r => r.adaptation.paths.length)) {
      for (const r of results) checkpoint(r.source.id, r.plan.to, r.plan.release, r.selectionsHash);
      state.history.push({ at, outcome: 'skipped', sources: Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, { to: s.to, ...(s.release ? { release: s.release } : {}), ...(s.decisions ? { decisions: s.decisions } : {}) }])) });
      return finish('skipped', { message: 'The agent found nothing to change. Its reasons are in state.json history.' });
    }
    const branch = `oc-port/${port.name}-${hash(results.map(r => [r.source.id, r.plan.to])).slice(0, 12)}`;
    if ((await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).trim()) throw new Error(`Branch ${branch} already exists in ${repository} without an open PR. Delete it or open the PR by hand.`);
    await git(root, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${branch}`]);
    const title = results.length === 1 ? `Port ${results[0]!.source.id} ${label(results[0]!.plan)}` : `Port ${results.length} upstreams: ${results.map(r => `${r.source.id} ${label(r.plan)}`).join(', ')}`;
    const pr = await github.createPullRequest({ repository, base: port.target.base, head: branch, title, body: pullRequestBody(port, results, sources), draft: port.target.draft });
    state.pending = { number: pr.number, url: pr.url, branch, openedAt: at, sources };
    return finish('proposal', { pr: pr.url });
  } catch (error) {
    if (invoked) {
      const message = oneLine((error as Error).message, 2000);
      state.failed = { key, count: state.failed?.key === key ? state.failed.count + 1 : 1, at, message };
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function runHub(hub: string, options: HubOptions = {}): Promise<PortOutcome[]> {
  if (options.model !== undefined && !/^[^\s/]+\/[^\s]+$/.test(options.model)) throw new Error('--model must be provider/model, optionally followed by #variant');
  const names = options.port !== undefined ? [options.port] : await listPorts(hub);
  if (!names.length) throw new Error(`No ports found. Add ports/<name>/ folders to ${hub}`);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const outcomes: PortOutcome[] = [];
  const owners = new Map<string, string>();
  for (const name of names) {
    const directory = NAME.test(name) ? join(hub, PORTS, name) : undefined;
    let state: PortState | undefined;
    try {
      if (directory) state = await readState(directory);
      const port = await loadPort(hub, name);
      const owner = owners.get(port.target.repository.toLowerCase());
      if (owner) throw new Error(`${port.target.repository} is already handled by ports/${owner}`);
      owners.set(port.target.repository.toLowerCase(), name);
      if (options.model !== undefined) for (const source of port.sources) source.config.opencode.model = options.model;
      outcomes.push(await runPort(hub, port, state!, options));
    } catch (error) {
      const message = oneLine((error as Error).message, 2000);
      outcomes.push({ port: name, status: 'error', message });
      if (state) state.lastRun = { at, status: 'error', message, latest: state.lastRun?.latest ?? {} };
    }
    if (state && directory && await exists(directory)) await writeState(directory, state);
  }
  await writeStatus(hub, at);
  return outcomes;
}

export interface PlannedPort { port: string; runner: string; work: boolean }
// Decides which ports need their own runner today, without writing anything. Ports with nothing to port
// (or with errors to record) run reconcile-only on ubuntu-latest, so macOS runners are used only for real work.
export async function planHub(hub: string, options: HubOptions = {}): Promise<PlannedPort[]> {
  const planned: PlannedPort[] = [];
  for (const name of await listPorts(hub)) {
    if (!NAME.test(name)) continue;
    let entry: PlannedPort = { port: name, runner: 'ubuntu-latest', work: false };
    try {
      const port = await loadPort(hub, name);
      const outcome = await runPort(hub, port, structuredClone(await readState(port.directory)), { ...options, reconcileOnly: true });
      if (outcome.status === 'queued') entry = { port: name, runner: port.target.runner, work: true };
    } catch { /* The reconcile-only run records the error. */ }
    planned.push(entry);
  }
  return planned;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';
export async function writeStatus(hub: string, at = new Date().toISOString()): Promise<string> {
  const rows: string[] = [];
  for (const name of await listPorts(hub)) {
    let port: Port | undefined;
    let state: PortState | undefined;
    let problem = '';
    try { state = await readState(join(hub, PORTS, name)); port = await loadPort(hub, name); }
    catch (error) { problem = oneLine((error as Error).message, 160); }
    const run = state?.lastRun;
    const status = state?.pending ? `PR open: ${state.pending.url}` : run ? `${run.status}${run.message && run.status !== 'up-to-date' ? `: ${oneLine(run.message, 160)}` : ''}` : problem || 'not run yet';
    for (const source of port?.sources ?? [undefined]) {
      const upstream = source?.config.upstream;
      const following = !upstream ? '' : upstream.track === 'branch' ? `branch ${upstream.ref}` : `releases${upstream.tags ? ` ${upstream.tags}` : ''} (else ${upstream.ref})`;
      const synced = source && state?.upstreams[source.id];
      const newest = source && run?.latest[source.id];
      rows.push(`| ${cell(name)} | ${cell(port?.target.repository ?? '')} | ${cell(source ? `${source.id}: ${upstream!.repository}` : '')} | ${cell(following)} | ${cell(synced ? label({ to: synced.lastSyncedCommit, ...(synced.release ? { release: synced.release } : {}) }) : '')} | ${cell(newest ? label(newest) : '')} | ${cell(status)} |`);
    }
  }
  const text = `# Port status\n\nWritten by the hub on ${at}. Edit the folders in \`ports/\`, not this file.\n\n| Port | Target | Upstream | Following | Synced to | Newest upstream | Status |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  await writeFile(join(hub, STATUS), text);
  return text;
}

// Preview only: no GitHub calls, no model, no state changes.
export async function checkHub(hub: string, only?: string): Promise<unknown[]> {
  const report: unknown[] = [];
  for (const name of only !== undefined ? [only] : await listPorts(hub)) {
    try {
      const port = await loadPort(hub, name);
      const state = await readState(port.directory);
      if (state.pending) { report.push({ port: name, target: port.target.repository, status: 'waiting', pr: state.pending.url }); continue; }
      const sources = [];
      for (const source of port.sources) {
        const recorded = state.upstreams[source.id];
        const from = recorded?.lastSyncedCommit ?? (source.start && SHA.test(source.start) ? source.start : undefined);
        if (!from) { sources.push({ id: source.id, status: source.start ? `starts with "${source.start}" on the next run` : 'needs "start"' }); continue; }
        const plan = await planSource(hub, source.config, from, Boolean(recorded && recorded.selectionsHash !== selectionsHash(source.config)));
        const pending = plan.mode === 'adopt' || (plan.from !== plan.to && state.declined[source.id]?.to !== plan.to);
        sources.push({ id: source.id, from: plan.from, to: plan.to, ...(plan.release ? { release: plan.release } : {}), status: !pending ? 'up-to-date' : plan.selections.length ? 'will port' : 'will record (no selected files changed)', selections: plan.selections.map(s => s.id) });
      }
      report.push({ port: name, target: port.target.repository, sources });
    } catch (error) { report.push({ port: name, status: 'error', message: (error as Error).message }); }
  }
  return report;
}

export interface NewPort { target: string; upstream: string; ref?: string; base?: string; track?: UpstreamTracking; tags?: string }
export async function initPort(hub: string, name: string, options: NewPort): Promise<string> {
  if (!NAME.test(name)) throw new Error('Port names must be lowercase, like my-app');
  if (!REPOSITORY.test(options.target)) throw new Error('--target must be owner/name');
  const directory = join(hub, PORTS, name);
  if (await exists(directory)) throw new Error(`ports/${name} already exists; it was not overwritten`);
  const id = (/([^/]+?)(?:\.git)?\/?$/.exec(options.upstream)?.[1] ?? 'upstream').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'upstream';
  const upstream = {
    upstream: { repository: options.upstream, ref: options.ref ?? 'main', track: options.track ?? 'releases', ...(options.tags !== undefined ? { tags: options.tags } : {}) },
    start: 'adopt',
    selections: [{
      id: 'main-feature',
      description: 'EDIT ME: the upstream functionality this repository uses.',
      upstreamPaths: ['src/**'],
      targetPaths: ['src/**', 'test/**'],
      acceptance: ['EDIT ME: what must be true after a port, and which tests prove it.'],
    }],
    preserve: ['Keep target-only features and public APIs unless notes.md says otherwise.'],
  };
  const target = { version: 1, repository: options.target, base: options.base ?? 'main', draft: true, verification: [{ command: 'npm', args: ['ci'] }, { command: 'npm', args: ['test'] }] };
  // Validate before writing anything.
  parseConfig({ version: 1, upstream: upstream.upstream, selections: upstream.selections, preserve: upstream.preserve, verification: target.verification });
  await mkdir(join(directory, 'upstreams'), { recursive: true });
  await jsonWrite(join(directory, 'target.json'), target);
  await jsonWrite(join(directory, 'upstreams', `${id}.json`), upstream);
  await writeFile(join(directory, 'notes.md'), `# ${name}\n\nContext for the agent. This file is sent with every upstream change for ${options.target}.\n\n## What we use from upstream\n\n- Which features or modules, and where they live in this repository.\n\n## How we differ\n\n- Intentional differences: naming, architecture, APIs we kept, things we removed.\n\n## Never port\n\n- Upstream features this repository should not get.\n`);
  return directory;
}
