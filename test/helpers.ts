import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { git } from '../src/process.js';
import { CONFIG, parseConfig, type Config } from '../src/config.js';
import { initialize, jsonWrite, setBaseline } from '../src/upstream.js';
import type { Plan } from '../src/upstream.js';
import { RESULT } from '../src/agent.js';

export function configInput(repository = '/upstream'): Record<string, unknown> {
  return {
    version: 1, upstream: { repository, ref: 'main' },
    selections: [{ id: 'retry-policy', description: 'Keep client retry behavior aligned, not its implementation language.', upstreamPaths: ['src/**', 'test/**'], targetPaths: ['src/**', 'test/**'], acceptance: ['Transient errors retry once; permanent errors do not.'] }],
    preserve: ['Keep target-specific authentication.'],
    verification: [{ command: process.execPath, args: ['--test', 'test/client.test.mjs'] }],
    opencode: { maxAttempts: 1 },
  };
}
export const config = (): Config => parseConfig(configInput());
export const plan = (): Plan => ({ mode: 'sync', from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [], changedPaths: ['src/client.rs'], selections: config().selections, diff: '', before: [], after: [] });

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.name', 'Test']);
  await git(path, ['config', 'user.email', 'test@example.invalid']);
  await git(path, ['config', 'commit.gpgsign', 'false']);
  await git(path, ['config', 'core.hooksPath', '/dev/null']);
}
export async function commit(root: string, message = 'test change'): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
export async function fixture(t: TestContext): Promise<{ directory: string; upstream: string; target: string; baseline: string; config: Config }> {
  const directory = await mkdtemp(join(tmpdir(), 'oc-port-test-'));
  const upstream = join(directory, 'upstream');
  const target = join(directory, 'target');
  await initRepo(upstream);
  await mkdir(join(upstream, 'src'));
  await writeFile(join(upstream, 'src/client.rs'), 'pub fn retries() -> u32 { 1 }\n');
  const baseline = await commit(upstream, 'initial upstream');
  await initRepo(target);
  await mkdir(join(target, 'src'));
  await mkdir(join(target, 'test'));
  await writeFile(join(target, 'src/client.mjs'), 'export const retries = 1;\n');
  await writeFile(join(target, 'test/client.test.mjs'), "import { retries } from '../src/client.mjs';\nimport assert from 'node:assert/strict';\nassert.ok(retries >= 1);\n");
  await initialize(target, upstream, 'main');
  const input = configInput(upstream);
  await jsonWrite(join(target, CONFIG), input);
  await setBaseline(target, baseline);
  await commit(target, 'configure tracking');
  t.after(async () => {
    // Only remove disposable test worktrees registered by this fixture.
    const listing = await git(target, ['worktree', 'list', '--porcelain']);
    for (const line of listing.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length);
      if (path !== target && dirname(path).includes('/oc-port-agent-')) {
        await git(target, ['worktree', 'remove', '--force', path]);
        await rm(dirname(path), { recursive: true, force: true });
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, upstream, target, baseline, config: parseConfig(input) };
}
export async function changeUpstream(root: string, retries = 2): Promise<string> {
  await writeFile(join(root, 'src/client.rs'), `pub fn retries() -> u32 { ${retries} }\n`);
  return commit(root, 'change retry functionality');
}
export async function report(root: string, status = 'applied', reason = 'Adapted the selected behavior.'): Promise<void> {
  await jsonWrite(join(root, RESULT), { summary: reason, decisions: [{ selection: 'retry-policy', status, reason }] });
}
