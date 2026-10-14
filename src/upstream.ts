import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG, checkpointPath, type Config, type Selection, type State, loadConfig, parseState, policyHash, safePath, selected } from './config.js';
import { git, run } from './process.js';

export interface SourceFile { path: string; content: string }
export interface Plan {
  mode: 'sync' | 'adopt';
  from: string;
  to: string;
  commits: { sha: string; subject: string }[];
  changedPaths: string[];
  selections: Selection[];
  diff: string;
  before: SourceFile[];
  after: SourceFile[];
}

export async function repositoryRoot(cwd: string): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const bare = (await git(root, ['rev-parse', '--is-bare-repository'])).trim();
  if (bare !== 'false') throw new Error('Run from a non-bare target Git repository');
  return root;
}
export async function clean(root: string): Promise<void> {
  if ((await git(root, ['status', '--porcelain'])).trim()) throw new Error('Target worktree must be clean. Commit or preserve your changes before synchronizing.');
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function jsonWrite(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
}

export async function fetchUpstream(root: string, config: Config): Promise<{ cache: string; head: string }> {
  const id = createHash('sha256').update(config.upstream.repository).digest('hex').slice(0, 16);
  const cache = join(root, '.oc-port', 'cache', `${id}.git`);
  await mkdir(cache, { recursive: true });
  if (!(await exists(join(cache, 'HEAD')))) {
    await git(root, ['init', '--bare', cache]);
    await git(cache, ['remote', 'add', 'origin', config.upstream.repository]);
  }
  const remote = (await git(cache, ['remote', 'get-url', 'origin'])).trim();
  if (remote !== config.upstream.repository) throw new Error('Upstream cache remote does not match configuration');
  await git(cache, ['check-ref-format', `refs/heads/${config.upstream.ref}`]);
  // Compare against the freshly fetched remote-tracking ref, NEVER cached local HEAD.
  await git(cache, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', 'origin', `+refs/heads/${config.upstream.ref}:refs/remotes/origin/oc-port`]);
  const head = (await git(cache, ['rev-parse', '--verify', 'refs/remotes/origin/oc-port^{commit}'])).trim();
  return { cache, head };
}

export async function setBaseline(root: string, commit: string, file = CONFIG): Promise<State> {
  const config = await loadConfig(root, file);
  const { cache, head } = await fetchUpstream(root, config);
  if (commit !== 'HEAD' && !/^[a-f0-9]{7,64}$/.test(commit)) throw new Error('Baseline must be HEAD or a hexadecimal upstream commit SHA');
  const sha = (await git(cache, ['rev-parse', '--verify', `${commit === 'HEAD' ? head : commit}^{commit}`])).trim();
  const ancestor = await run('git', ['merge-base', '--is-ancestor', sha, head], cache);
  if (ancestor.code !== 0) throw new Error('Baseline is not an ancestor of the configured upstream branch');
  const state: State = { version: 1, upstream: config.upstream, policyHash: policyHash(config), lastSyncedCommit: sha };
  const destination = join(root, checkpointPath(config));
  await mkdir(dirname(destination), { recursive: true });
  await jsonWrite(destination, state);
  return state;
}

async function sourceFiles(cache: string, sha: string, selections: Selection[]): Promise<SourceFile[]> {
  const entries = (await git(cache, ['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean);
  const result: SourceFile[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    if (!selections.some(selection => selected(path, selection))) continue;
    if (tab < 0 || !safePath(path)) throw new Error(`Unsafe upstream path: ${JSON.stringify(path)}`);
    const [mode, type, blob] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode!)) throw new Error(`Selected upstream symlink/submodule needs manual handling: ${path}`);
    const content = await git(cache, ['cat-file', 'blob', blob!]);
    if (content.includes('\0') || content.includes('\ufffd')) throw new Error(`Selected binary or non-UTF-8 file needs manual handling: ${path}`);
    result.push({ path, content });
  }
  return result;
}

export async function planSync(root: string, full = false, file = CONFIG): Promise<{ config: Config; state: State; plan: Plan }> {
  const config = await loadConfig(root, file);
  let state: State;
  try { state = parseState(JSON.parse(await readFile(join(root, checkpointPath(config)), 'utf8')), config); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!config.baselineCommit) throw new Error('No checkpoint. Run baseline --commit <upstream-SHA> explicitly; use HEAD then sync --full for an initial adoption.');
    state = { version: 1, upstream: config.upstream, policyHash: policyHash(config), lastSyncedCommit: config.baselineCommit };
  }
  const { cache, head } = await fetchUpstream(root, config);
  const ancestor = await run('git', ['merge-base', '--is-ancestor', state.lastSyncedCommit, head], cache);
  if (ancestor.code !== 0) throw new Error('Upstream history diverged or the checkpoint is unavailable. Stop and review before setting a new baseline.');
  const count = Number((await git(cache, ['rev-list', '--count', `${state.lastSyncedCommit}..${head}`])).trim());
  if (count > config.limits.maxCommits) throw new Error(`Upstream backlog has ${count} commits (limit ${config.limits.maxCommits}). Review and increase limits.maxCommits; no checkpoint was advanced.`);
  const commits = (await git(cache, ['log', '--reverse', '--format=%H%x09%s', `${state.lastSyncedCommit}..${head}`])).split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('\t');
    return { sha: line.slice(0, index), subject: line.slice(index + 1) };
  });
  const changedPaths = (await git(cache, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', state.lastSyncedCommit, head])).split('\0').filter(Boolean);
  if (changedPaths.some(path => !safePath(path))) throw new Error('Upstream diff contains an unsafe path');
  const selections = config.selections.filter(selection => full || changedPaths.some(path => selected(path, selection)));
  const paths = changedPaths.filter(path => selections.some(selection => selected(path, selection)));
  const diff = paths.length ? await git(cache, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', state.lastSyncedCommit, head, '--', ...paths]) : '';
  const before = selections.length ? await sourceFiles(cache, state.lastSyncedCommit, selections) : [];
  const after = selections.length ? await sourceFiles(cache, head, selections) : [];
  if (full && !before.length && !after.length) throw new Error('No upstream files match the configured selections');
  const plan: Plan = { mode: full ? 'adopt' : 'sync', from: state.lastSyncedCommit, to: head, commits, changedPaths, selections, diff, before, after };
  const bytes = Buffer.byteLength(JSON.stringify(plan));
  if (bytes > config.limits.maxContextBytes) throw new Error(`Complete upstream context is ${bytes} bytes (limit ${config.limits.maxContextBytes}). Narrow selections or increase the limit; context is never silently truncated.`);
  return { config, state, plan };
}

export async function initialize(root: string, repository: string, ref: string): Promise<void> {
  if (await exists(join(root, CONFIG))) throw new Error(`${CONFIG} already exists; it was not overwritten`);
  const config = {
    version: 1,
    upstream: { repository, ref },
    selections: [{
      id: 'desired-functionality',
      description: 'EDIT ME: describe the exact upstream functionality to adopt and keep aligned.',
      upstreamPaths: ['src/**', 'test/**'], excludeUpstreamPaths: [],
      targetPaths: ['src/**', 'test/**'],
      acceptance: ['EDIT ME: describe observable behavior and the tests that prove it.'], mappings: [],
    }],
    preserve: ['Preserve target-only features and public compatibility unless explicitly approved.'],
    protectedPaths: ['.github/workflows/**', 'AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md'],
    verification: [{ command: 'npm', args: ['test'], timeoutSeconds: 300 }],
    opencode: { timeoutSeconds: 1200, maxAttempts: 2, steps: 100 },
    limits: { maxCommits: 100, maxContextBytes: 1_000_000 },
  };
  // Validate before materializing any configuration, including CLI input.
  const { parseConfig } = await import('./config.js');
  parseConfig(config);
  await writeFile(join(root, CONFIG), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const ignore = join(root, '.gitignore');
  const addition = '\n# oc-port-agent local cache and model output\n.oc-port/cache/\n.oc-port/context/\n.oc-port/result.json\n.oc-port/agent-output.log\n';
  const previous = await exists(ignore) ? await readFile(ignore, 'utf8') : '';
  await writeFile(ignore, previous + addition);
}
