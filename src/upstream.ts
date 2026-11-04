import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG, checkpointPath, type Config, type Selection, type State, type UpstreamTracking, loadConfig, matches, parseConfig, parseState, policyHash, safePath, selected, upstreamSource } from './config.js';
import { git, run, runBytes } from './process.js';

export interface SourceFile { path: string; content: string }
export interface Plan {
  mode: 'sync' | 'adopt';
  from: string;
  to: string;
  // Release tag name when `to` is the newest upstream release.
  release?: string;
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

// Stable versions only: v1.2.3, 1.2.3 or v1.2. Prereleases (-rc.1) are always ignored.
const RELEASE_TAG = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/;
// With an operator pattern, the version may follow a prefix such as pkg@ or release-.
const PREFIXED_RELEASE_TAG = /(?:^|[@/_-])v?(\d+)\.(\d+)(?:\.(\d+))?$/;
// Tag names end up in PR titles and bodies; anything else is not a release name we accept.
const PLAIN_TAG = /^[A-Za-z0-9._@/+-]+$/;
export function latestRelease(tags: string[], pattern?: string): string | undefined {
  let best: { name: string; version: number[] } | undefined;
  for (const name of tags) {
    if (!PLAIN_TAG.test(name) || (pattern !== undefined && !matches(name, pattern))) continue;
    const match = (pattern === undefined ? RELEASE_TAG : PREFIXED_RELEASE_TAG).exec(name);
    if (!match) continue;
    const version = [match[1]!, match[2]!, match[3] ?? '0'].map(Number);
    const order = best ? (version.map((part, i) => part - best!.version[i]!).find(difference => difference !== 0) ?? 0) : 1;
    if (order > 0 || (order === 0 && name < best!.name)) best = { name, version };
  }
  return best?.name;
}

export interface UpstreamHead { cache: string; head: string; branchHead: string; release?: string }
// head is the newest release when one exists and releases are tracked; otherwise the branch head.
export async function fetchUpstream(root: string, config: Config): Promise<UpstreamHead> {
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
  let release: string | undefined;
  if (config.upstream.track === 'releases') {
    // Listing tag names is cheap; only the newest release's history is fetched.
    const listing = await git(cache, ['ls-remote', '--tags', '--refs', 'origin']);
    release = latestRelease(listing.split('\n').map(line => line.split('\t')[1] ?? '').filter(ref => ref.startsWith('refs/tags/')).map(ref => ref.slice('refs/tags/'.length)), config.upstream.tags);
    // An explicit pattern that matches nothing is more likely a typo than a reason to follow the branch.
    if (!release && config.upstream.tags !== undefined) throw new Error(`No upstream release tags match upstream.tags "${config.upstream.tags}"`);
    if (release) await git(cache, ['check-ref-format', `refs/tags/${release}`]);
  }
  const refspecs = [`+refs/heads/${config.upstream.ref}:refs/remotes/origin/oc-port`, ...(release ? [`+refs/tags/${release}:refs/remotes/origin/oc-port-release`] : [])];
  // Compare against freshly fetched remote-tracking refs, NEVER cached local HEAD.
  await git(cache, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', 'origin', ...refspecs]);
  const branchHead = (await git(cache, ['rev-parse', '--verify', 'refs/remotes/origin/oc-port^{commit}'])).trim();
  if (!release) return { cache, head: branchHead, branchHead };
  const head = (await git(cache, ['rev-parse', '--verify', 'refs/remotes/origin/oc-port-release^{commit}'])).trim();
  return { cache, head, branchHead, release };
}
const contains = async (cache: string, tip: string, commit: string): Promise<boolean> => (await run('git', ['merge-base', '--is-ancestor', commit, tip], cache)).code === 0;

export async function setBaseline(root: string, commit: string, file = CONFIG): Promise<State> {
  const config = await loadConfig(root, file);
  const { cache, head, branchHead } = await fetchUpstream(root, config);
  if (commit !== 'HEAD' && !/^[a-f0-9]{7,64}$/.test(commit)) throw new Error('Baseline must be HEAD or a hexadecimal upstream commit SHA');
  // HEAD means the tracked revision: the newest release when releases are tracked.
  const sha = (await git(cache, ['rev-parse', '--verify', `${commit === 'HEAD' ? head : commit}^{commit}`])).trim();
  if (!await contains(cache, head, sha) && !await contains(cache, branchHead, sha)) throw new Error('Baseline is not in the history of the tracked upstream release or branch');
  const state: State = { version: 1, upstream: upstreamSource(config), policyHash: policyHash(config), lastSyncedCommit: sha };
  const destination = join(root, checkpointPath(config));
  await mkdir(dirname(destination), { recursive: true });
  await jsonWrite(destination, state);
  return state;
}

async function sourceFiles(cache: string, sha: string, selections: Selection[], allowNulTextPaths: string[]): Promise<SourceFile[]> {
  const entries = (await git(cache, ['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean);
  const result: SourceFile[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    if (!selections.some(selection => selected(path, selection))) continue;
    if (tab < 0 || !safePath(path)) throw new Error(`Unsafe upstream path: ${JSON.stringify(path)}`);
    const [mode, type, blob] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode!)) throw new Error(`Selected upstream symlink/submodule needs manual handling: ${path}`);
    const raw = await runBytes('git', ['cat-file', 'blob', blob!], cache);
    if (raw.code !== 0) throw new Error(`Reading upstream blob failed: ${path}\n${raw.stderr}`);
    let content: string;
    try {
      // ignoreBOM preserves a leading U+FEFF, rather than stripping source bytes.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.stdout);
    } catch { throw new Error(`Selected non-UTF-8 file needs manual handling: ${path}`); }
    if (content.includes('\0') && !allowNulTextPaths.includes(path)) throw new Error(`Selected binary or non-UTF-8 file needs manual handling: ${path}`);
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
    state = { version: 1, upstream: upstreamSource(config), policyHash: policyHash(config), lastSyncedCommit: config.baselineCommit };
  }
  return { config, state, plan: await planSource(root, config, state.lastSyncedCommit, full) };
}

// Plans from an explicit checkpoint. cacheRoot holds .oc-port/cache; the hub keeps it outside targets.
export async function planSource(cacheRoot: string, config: Config, from: string, full = false): Promise<Plan> {
  const upstream = await fetchUpstream(cacheRoot, config);
  const { cache } = upstream;
  let head = upstream.head;
  // A checkpoint already past the newest release (e.g. from branch tracking) waits for the next release.
  if (upstream.release && head !== from && await contains(cache, from, head)) head = from;
  const release = upstream.release && head === upstream.head ? upstream.release : undefined;
  if (!await contains(cache, head, from)) {
    throw new Error(upstream.release
      ? `Upstream release ${upstream.release} does not contain the checkpoint (it may be on another release branch). Stop and review before setting a new baseline, or set upstream.track to "branch".`
      : 'Upstream history diverged or the checkpoint is unavailable. Stop and review before setting a new baseline.');
  }
  const count = Number((await git(cache, ['rev-list', '--count', `${from}..${head}`])).trim());
  if (count > config.limits.maxCommits) throw new Error(`Upstream backlog has ${count} commits (limit ${config.limits.maxCommits}). Review and increase limits.maxCommits; no checkpoint was advanced.`);
  const commits = (await git(cache, ['log', '--reverse', '--format=%H%x09%s', `${from}..${head}`])).split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('\t');
    return { sha: line.slice(0, index), subject: line.slice(index + 1) };
  });
  const changedPaths = (await git(cache, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', from, head])).split('\0').filter(Boolean);
  if (changedPaths.some(path => !safePath(path))) throw new Error('Upstream diff contains an unsafe path');
  const selections = config.selections.filter(selection => full || changedPaths.some(path => selected(path, selection)));
  const paths = changedPaths.filter(path => selections.some(selection => selected(path, selection)));
  const diff = paths.length ? await git(cache, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', from, head, '--', ...paths]) : '';
  const before = selections.length ? await sourceFiles(cache, from, selections, config.allowNulTextPaths) : [];
  const after = selections.length ? await sourceFiles(cache, head, selections, config.allowNulTextPaths) : [];
  if (full && !before.length && !after.length) throw new Error('No upstream files match the configured selections');
  const plan: Plan = { mode: full ? 'adopt' : 'sync', from, to: head, ...(release ? { release } : {}), commits, changedPaths, selections, diff, before, after };
  const bytes = Buffer.byteLength(JSON.stringify(plan));
  if (bytes > config.limits.maxContextBytes) throw new Error(`Complete upstream context is ${bytes} bytes (limit ${config.limits.maxContextBytes}). Narrow selections or increase the limit; context is never silently truncated.`);
  return plan;
}

export interface Tracking { track?: UpstreamTracking; tags?: string }
export async function initialize(root: string, repository: string, ref: string, file = CONFIG, tracking: Tracking = {}): Promise<void> {
  if (!safePath(file) || /[?*]/.test(file)) throw new Error('--config must be an exact repository-relative file');
  if (await exists(join(root, file))) throw new Error(`${file} already exists; it was not overwritten`);
  const config = {
    version: 1,
    upstream: { repository, ref, track: tracking.track ?? 'releases', ...(tracking.tags !== undefined ? { tags: tracking.tags } : {}) },
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
  parseConfig(config);
  let parent = root;
  for (const part of file.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (!await exists(parent)) await mkdir(parent);
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('--config parent directories cannot be symlinks');
  }
  await writeFile(join(root, file), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const ignore = join(root, '.gitignore');
  const previous = await exists(ignore) ? await readFile(ignore, 'utf8') : '';
  const missing = ['.oc-port/cache/', '.oc-port/context/', '.oc-port/result.json', '.oc-port/agent-output.log'].filter(path => !previous.split(/\r?\n/).includes(path));
  if (missing.length) await writeFile(ignore, previous + '\n# oc-port-agent local cache and model output\n' + missing.join('\n') + '\n');
}
