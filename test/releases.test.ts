import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, parseConfig, policyHash } from '../src/config.js';
import { jsonWrite, latestRelease, planSync, setBaseline } from '../src/upstream.js';
import { synchronize } from '../src/sync.js';
import { main } from '../src/cli.js';
import { git } from '../src/process.js';
import { changeUpstream, commit, config, configInput, fixture, report } from './helpers.js';

const tag = (root: string, name: string, commit?: string) => git(root, ['-c', 'tag.gpgSign=false', 'tag', '-a', name, '-m', `Release ${name}`, ...(commit ? [commit] : [])]);
const mustNotInvoke = async (): Promise<void> => { throw new Error('Must not invoke'); };

test('the newest stable version tag wins; prereleases and other tags are ignored', () => {
  assert.equal(latestRelease(['v1.2.3', 'v1.10.0', 'v1.9.9', 'v2.0.0-rc.1', 'pkg@3.0.0', 'nightly', 'v1.2']), 'v1.10.0');
  assert.equal(latestRelease(['nightly', 'v2.0.0-beta.1']), undefined);
  assert.equal(latestRelease([]), undefined);
});
test('releases are tracked by default, and unreleased branch commits are not', async t => {
  const f = await fixture(t);
  await tag(f.upstream, 'v1.0.0', f.baseline);
  const released = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  await changeUpstream(f.upstream, 3);
  await tag(f.upstream, 'v1.2.0-rc.1');
  await changeUpstream(f.upstream, 4);
  const { plan } = await planSync(f.target);
  assert.equal(plan.to, released);
  assert.equal(plan.release, 'v1.1.0');
  assert.ok(plan.after[0]!.content.includes('{ 2 }'));
});
test('new branch commits without a new release do not invoke the model', async t => {
  const f = await fixture(t);
  await tag(f.upstream, 'v1.0.0', f.baseline);
  await changeUpstream(f.upstream);
  const result = await synchronize(f.target, { invoke: mustNotInvoke });
  assert.equal(result.status, 'up-to-date');
});
test('a checkpoint already past the newest release waits for the next release', async t => {
  const f = await fixture(t);
  await tag(f.upstream, 'v1.0.0', f.baseline);
  const ahead = await changeUpstream(f.upstream, 2);
  await setBaseline(f.target, ahead);
  await commit(f.target, 'checkpoint past the latest release');
  assert.equal((await synchronize(f.target, { invoke: mustNotInvoke })).status, 'up-to-date');

  const next = await changeUpstream(f.upstream, 3);
  await tag(f.upstream, 'v1.1.0');
  const result = await synchronize(f.target, { invoke: async root => {
    await writeFile(join(root, 'src/client.mjs'), 'export const retries = 3;\n');
    await report(root);
  } });
  assert.equal(result.status, 'proposal');
  const evidence = JSON.parse(await readFile(join(result.worktree!, result.report!), 'utf8'));
  assert.equal(evidence.from, ahead);
  assert.equal(evidence.to, next);
  assert.equal(evidence.release, 'v1.1.0');
  assert.equal((await git(result.worktree!, ['log', '-1', '--format=%s'])).trim(), 'Sync upstream release v1.1.0');
});
test('baseline HEAD means the newest release', async t => {
  const f = await fixture(t);
  const released = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v2.0.0');
  await changeUpstream(f.upstream, 3);
  assert.equal((await setBaseline(f.target, 'HEAD')).lastSyncedCommit, released);
});
test('a release that does not contain the checkpoint stops for review', async t => {
  const f = await fixture(t);
  const ahead = await changeUpstream(f.upstream, 2);
  await setBaseline(f.target, ahead);
  await commit(f.target, 'checkpoint on main');
  await git(f.upstream, ['checkout', '-b', 'release-1', f.baseline]);
  await changeUpstream(f.upstream, 5);
  await tag(f.upstream, 'v1.0.1');
  await assert.rejects(planSync(f.target), /release v1\.0\.1 does not contain the checkpoint/);
});
test('track "branch" ignores release tags and keeps the existing checkpoint valid', async t => {
  const f = await fixture(t);
  const input = JSON.parse(await readFile(join(f.target, CONFIG), 'utf8'));
  input.upstream.track = 'branch';
  await jsonWrite(join(f.target, CONFIG), input);
  await commit(f.target, 'follow the branch');
  await tag(f.upstream, 'v1.0.0', f.baseline);
  const head = await changeUpstream(f.upstream);
  const { plan } = await planSync(f.target);
  assert.equal(plan.to, head);
  assert.equal(plan.release, undefined);
});
test('upstream.track and upstream.tags are validated and not part of the policy hash', () => {
  const upstream = (fields: Record<string, unknown>) => parseConfig({ ...configInput(), upstream: { repository: '/upstream', ref: 'main', ...fields } });
  assert.equal(upstream({ track: 'branch' }).upstream.track, 'branch');
  assert.equal(config().upstream.track, 'releases');
  assert.equal(upstream({ tags: '@scope/pkg@*' }).upstream.tags, '@scope/pkg@*');
  assert.equal(policyHash(upstream({ track: 'branch' })), policyHash(config()));
  assert.equal(policyHash(upstream({ tags: 'v2.*' })), policyHash(config()));
  assert.throws(() => upstream({ track: 'tags' }), /upstream\.track/);
  assert.throws(() => upstream({ track: 'branch', tags: 'v2.*' }), /only applies when upstream\.track is "releases"/);
  assert.throws(() => upstream({ tags: 'v2.* `x`' }), /tag name pattern/);
  assert.throws(() => upstream({ tags: '../v2.*' }), /tag name pattern/);
});
test('a tag pattern picks one release line or one monorepo package', () => {
  const tags = ['v1.9.0', 'v2.1.0', 'v2.10.0', 'v2.11.0-rc.1', 'v3.0.0', '@scope/a@1.2.0', '@scope/a@1.10.0', '@scope/a@2.0.0-beta.1', '@scope/b@9.0.0', 'release-1.3.0', 'release-1.2.9'];
  assert.equal(latestRelease(tags, 'v2.*'), 'v2.10.0');
  assert.equal(latestRelease(tags, '@scope/a@*'), '@scope/a@1.10.0');
  assert.equal(latestRelease(tags, 'release-*'), 'release-1.3.0');
  assert.equal(latestRelease(tags, 'v4.*'), undefined);
  assert.equal(latestRelease(['v2.0.0', 'v2.1.0`'], 'v2.*'), 'v2.0.0');
});
test('a configured tag pattern controls which upstream release is synced', async t => {
  const f = await fixture(t);
  const input = JSON.parse(await readFile(join(f.target, CONFIG), 'utf8'));
  input.upstream.tags = '@scope/pkg@*';
  await jsonWrite(join(f.target, CONFIG), input);
  await commit(f.target, 'follow one package');
  const packaged = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, '@scope/pkg@1.4.0');
  await changeUpstream(f.upstream, 3);
  await tag(f.upstream, 'v9.0.0');
  const { plan } = await planSync(f.target);
  assert.equal(plan.to, packaged);
  assert.equal(plan.release, '@scope/pkg@1.4.0');
});
test('a tag pattern that matches nothing stops instead of following the branch', async t => {
  const f = await fixture(t);
  const input = JSON.parse(await readFile(join(f.target, CONFIG), 'utf8'));
  input.upstream.tags = 'v2.*';
  await jsonWrite(join(f.target, CONFIG), input);
  await commit(f.target, 'follow v2');
  await changeUpstream(f.upstream);
  await tag(f.upstream, 'v1.0.0');
  await assert.rejects(planSync(f.target), /No upstream release tags match upstream\.tags "v2\.\*"/);
});
test('track "branch" follows the configured branch, not main', async t => {
  const f = await fixture(t);
  await tag(f.upstream, 'v1.0.0', f.baseline);
  await git(f.upstream, ['checkout', '-b', 'release/1.x', f.baseline]);
  const fix = await changeUpstream(f.upstream, 5);
  await git(f.upstream, ['checkout', 'main']);
  await changeUpstream(f.upstream, 6);
  const input = JSON.parse(await readFile(join(f.target, CONFIG), 'utf8'));
  input.upstream = { repository: f.upstream, ref: 'release/1.x', track: 'branch' };
  await mkdir(join(f.target, 'policies'), { recursive: true });
  await jsonWrite(join(f.target, 'policies/release.json'), input);
  await setBaseline(f.target, f.baseline, 'policies/release.json');
  await commit(f.target, 'follow release/1.x');
  const { plan } = await planSync(f.target, false, 'policies/release.json');
  assert.equal(plan.to, fix);
  assert.ok(plan.after[0]!.content.includes('{ 5 }'));
});
test('init records the branch, tracking mode and tag pattern', async t => {
  const f = await fixture(t);
  await main(['init', '--upstream', f.upstream, '--ref', 'release/1.x', '--track', 'branch', '--config', 'policies/branch.json'], f.target);
  await main(['init', '--upstream', f.upstream, '--tags', 'v2.*', '--config', 'policies/v2.json'], f.target);
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'policies/branch.json'), 'utf8')).upstream, { repository: f.upstream, ref: 'release/1.x', track: 'branch' });
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'policies/v2.json'), 'utf8')).upstream, { repository: f.upstream, ref: 'main', track: 'releases', tags: 'v2.*' });
  await assert.rejects(main(['init', '--upstream', f.upstream, '--track', 'tags', '--config', 'policies/bad.json'], f.target), /--track must be releases or branch/);
  await assert.rejects(main(['init', '--upstream', f.upstream, '--track', 'branch', '--tags', 'v2.*', '--config', 'policies/bad.json'], f.target), /only applies/);
});
