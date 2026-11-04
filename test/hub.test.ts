import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHub, initPort, runHub, type HubGitHub, type PortState } from '../src/hub.js';
import { jsonWrite } from '../src/upstream.js';
import { main } from '../src/cli.js';
import { git } from '../src/process.js';
import { changeUpstream, commit, initRepo, report } from './helpers.js';

interface FakePullRequest { number: number; url: string; head: string; base: string; title: string; body: string; draft: boolean; state: 'open' | 'closed'; merged: boolean }
function fakeGitHub(bare: string): HubGitHub & { prs: FakePullRequest[] } {
  const prs: FakePullRequest[] = [];
  return {
    prs,
    async clone(_repository, base, directory) { await git(tmpdir(), ['clone', '--branch', base, bare, directory]); },
    async openPullRequests() { return prs.filter(pr => pr.state === 'open').map(({ number, url, head, body }) => ({ number, url, head, body })); },
    async pullRequest(_repository, number) { const pr = prs.find(item => item.number === number)!; return { state: pr.state, merged: pr.merged, url: pr.url }; },
    async createPullRequest(request) {
      const number = prs.length + 1;
      const url = `https://github.com/${request.repository}/pull/${number}`;
      prs.push({ ...request, number, url, state: 'open', merged: false });
      return { number, url };
    },
  };
}

const tag = (root: string, name: string) => git(root, ['-c', 'tag.gpgSign=false', 'tag', '-a', name, '-m', name]);
const state = async (hub: string, name = 'demo'): Promise<PortState> => JSON.parse(await readFile(join(hub, 'ports', name, 'state.json'), 'utf8'));
const mustNotInvoke = async (): Promise<void> => { throw new Error('Must not invoke'); };
const port = (retries: number) => async (root: string): Promise<void> => {
  await writeFile(join(root, 'src/client.mjs'), `export const retries = ${retries};\n`);
  await report(root);
};

async function hubFixture(t: TestContext, start?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-port-hub-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = join(directory, 'upstream');
  await initRepo(upstream);
  await mkdir(join(upstream, 'src'));
  await writeFile(join(upstream, 'src/client.rs'), 'pub fn retries() -> u32 { 1 }\n');
  const baseline = await commit(upstream, 'initial upstream');
  const work = join(directory, 'target-work');
  await initRepo(work);
  await mkdir(join(work, 'src'));
  await mkdir(join(work, 'test'));
  await writeFile(join(work, 'src/client.mjs'), 'export const retries = 1;\n');
  await writeFile(join(work, 'test/client.test.mjs'), "import { retries } from '../src/client.mjs';\nimport assert from 'node:assert/strict';\nassert.ok(retries >= 1);\n");
  await commit(work, 'target');
  const bare = join(directory, 'target.git');
  await git(directory, ['clone', '--bare', work, bare]);
  const hub = join(directory, 'hub');
  const folder = join(hub, 'ports', 'demo');
  await mkdir(join(folder, 'upstreams'), { recursive: true });
  await jsonWrite(join(folder, 'target.json'), { version: 1, repository: 'kyeshmz/demo', base: 'main', verification: [{ command: process.execPath, args: ['--test', 'test/client.test.mjs'] }], opencode: { maxAttempts: 1 } });
  await jsonWrite(join(folder, 'upstreams', 'client.json'), {
    upstream: { repository: upstream, ref: 'main' },
    start: start ?? baseline,
    selections: [{ id: 'retry-policy', description: 'Keep retry counts aligned.', upstreamPaths: ['src/**'], targetPaths: ['src/**', 'test/**'], acceptance: ['Retries match upstream.'] }],
    preserve: ['Keep target-specific authentication.'],
  });
  await writeFile(join(folder, 'notes.md'), 'The target keeps its own authentication layer.\n');
  return { directory, upstream, baseline, bare, hub, github: fakeGitHub(bare) };
}

test('a new upstream release becomes one PR in the target, with notes.md as agent context', async t => {
  const f = await hubFixture(t);
  const released = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  let notes = '';
  const [outcome] = await runHub(f.hub, { github: f.github, invoke: async (root, _config, packet) => {
    notes = JSON.parse(await readFile(packet, 'utf8')).policy.notes;
    await port(2)(root);
  } });
  assert.equal(outcome!.status, 'proposal');
  assert.match(notes, /keeps its own authentication/);
  const [pr] = f.github.prs;
  assert.equal(pr!.title, 'Port client v1.1.0');
  assert.ok(pr!.draft);
  assert.match(pr!.head, /^oc-port\/demo-[a-f0-9]{12}$/);
  assert.match(pr!.body, /<!-- oc-port-hub \{.*"to":"[a-f0-9]{40}".*\} -->/);
  assert.match(await git(f.bare, ['show', `${pr!.head}:src/client.mjs`]), /retries = 2/);
  assert.ok(!(await git(f.bare, ['ls-tree', '-r', '--name-only', pr!.head])).includes('.oc-port'), 'hub files never land in the target');
  const recorded = await state(f.hub);
  assert.equal(recorded.pending!.number, 1);
  assert.equal(recorded.pending!.sources.client!.to, released);
  assert.equal(recorded.upstreams.client!.lastSyncedCommit, f.baseline, 'the checkpoint moves only when the PR merges');
  assert.match(await readFile(join(f.hub, 'STATUS.md'), 'utf8'), /\| demo \| kyeshmz\/demo \|.*PR open: https:\/\/github.com\/kyeshmz\/demo\/pull\/1/);
});
test('an open PR waits, a merged PR records the release, and an unchanged upstream stays quiet', async t => {
  const f = await hubFixture(t);
  const released = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  await runHub(f.hub, { github: f.github, invoke: port(2) });
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'waiting');
  Object.assign(f.github.prs[0]!, { state: 'closed', merged: true });
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'up-to-date');
  const recorded = await state(f.hub);
  assert.deepEqual([recorded.upstreams.client!.lastSyncedCommit, recorded.upstreams.client!.release], [released, 'v1.1.0']);
  assert.equal(recorded.pending, undefined);
  assert.equal(recorded.history.at(-1)!.outcome, 'merged');
  await changeUpstream(f.upstream, 3);
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'up-to-date', 'unreleased commits wait for a release');
});
test('a closed PR skips that release, and the next release is ported with that history', async t => {
  const f = await hubFixture(t);
  await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  await runHub(f.hub, { github: f.github, invoke: port(2) });
  Object.assign(f.github.prs[0]!, { state: 'closed', merged: false });
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'up-to-date');
  assert.equal((await state(f.hub)).declined.client!.release, 'v1.1.0');
  await changeUpstream(f.upstream, 3);
  await tag(f.upstream, 'v1.2.0');
  let packet: { plan: { from: string }; policy: { notes: string } } | undefined;
  const [outcome] = await runHub(f.hub, { github: f.github, invoke: async (root, _config, path) => { packet = JSON.parse(await readFile(path, 'utf8')); await port(3)(root); } });
  assert.equal(outcome!.status, 'proposal');
  assert.equal(packet!.plan.from, f.baseline, 'the declined release was never recorded as synced');
  assert.match(packet!.policy.notes, /closed https:\/\/github.com\/kyeshmz\/demo\/pull\/1: client v1\.1\.0 \(retry-policy applied/);
});
test('start "adopt" ports the existing functionality on the first run', async t => {
  const f = await hubFixture(t, 'adopt');
  let mode = '';
  await runHub(f.hub, { github: f.github, invoke: async (root, _config, packet) => { mode = JSON.parse(await readFile(packet, 'utf8')).plan.mode; await port(4)(root); } });
  assert.equal(mode, 'adopt');
  assert.equal(f.github.prs.length, 1);
});
test('start "latest" records the starting point without a model call', async t => {
  const f = await hubFixture(t, 'latest');
  await changeUpstream(f.upstream, 2);
  const released = (await git(f.upstream, ['rev-parse', 'HEAD'])).trim();
  await tag(f.upstream, 'v1.1.0');
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'up-to-date');
  const recorded = await state(f.hub);
  assert.equal(recorded.upstreams.client!.lastSyncedCommit, released);
  assert.equal(recorded.history.at(-1)!.outcome, 'baselined');
});
test('when the agent changes nothing, the hub records why and opens no PR', async t => {
  const f = await hubFixture(t);
  const released = await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  const [outcome] = await runHub(f.hub, { github: f.github, invoke: root => report(root, 'skipped', 'Already equivalent in the target.') });
  assert.equal(outcome!.status, 'skipped');
  assert.equal(f.github.prs.length, 0);
  const recorded = await state(f.hub);
  assert.equal(recorded.upstreams.client!.lastSyncedCommit, released);
  assert.equal(recorded.history.at(-1)!.sources.client!.decisions![0]!.reason, 'Already equivalent in the target.');
});
test('a failing port is reported, other ports still run, and the same failure is retried only once', async t => {
  const f = await hubFixture(t);
  await mkdir(join(f.hub, 'ports', 'broken'));
  await writeFile(join(f.hub, 'ports', 'broken', 'target.json'), '{ not json');
  await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  let attempts = 0;
  const failing = async (root: string): Promise<void> => { attempts++; await port(-1)(root); };
  const first = await runHub(f.hub, { github: f.github, invoke: failing });
  assert.deepEqual(first.map(o => [o.port, o.status]), [['broken', 'error'], ['demo', 'error']]);
  assert.match(first[1]!.message!, /Verification failed/);
  await runHub(f.hub, { github: f.github, invoke: failing });
  const third = await runHub(f.hub, { github: f.github, invoke: failing });
  assert.equal(attempts, 2);
  assert.match(third[1]!.message!, /Stopped after 2 failed attempts/);
  assert.match(await readFile(join(f.hub, 'STATUS.md'), 'utf8'), /\| broken \|.*target\.json/);
  // A failure before the model runs, like a missing App install, never counts toward the limit.
  const unreachable = { ...f.github, clone: async () => { throw new Error('Repository not found'); } };
  await writeFile(join(f.hub, 'ports', 'demo', 'notes.md'), 'Retries must stay positive.\n');
  for (let run = 0; run < 3; run++) assert.match((await runHub(f.hub, { port: 'demo', github: unreachable, invoke: failing }))[0]!.message!, /Repository not found/);
  assert.match((await state(f.hub)).failed!.message, /Verification failed/, 'clone failures leave the failure record alone');
  // Editing the port folder is the way to ask for another attempt.
  await writeFile(join(f.hub, 'ports', 'demo', 'notes.md'), 'Retries must stay positive.\n');
  assert.equal((await runHub(f.hub, { port: 'demo', github: f.github, invoke: port(2) }))[0]!.status, 'proposal');
});
test('an oc-port PR the hub did not open blocks the port; one it opened is picked up again', async t => {
  const f = await hubFixture(t);
  await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  f.github.prs.push({ number: 9, url: 'https://github.com/kyeshmz/demo/pull/9', head: 'oc-port/manual', base: 'main', title: 'manual', body: 'hand made', draft: true, state: 'open', merged: false });
  assert.match((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.message!, /Another oc-port PR is open/);
  f.github.prs.pop();
  await runHub(f.hub, { github: f.github, invoke: port(2) });
  const recorded = await state(f.hub);
  delete recorded.pending;
  await jsonWrite(join(f.hub, 'ports', 'demo', 'state.json'), recorded);
  assert.equal((await runHub(f.hub, { github: f.github, invoke: mustNotInvoke }))[0]!.status, 'waiting');
  assert.equal((await state(f.hub)).pending!.number, 1);
});
test('a target with two upstreams gets one PR with a commit per upstream', async t => {
  const f = await hubFixture(t);
  const second = join(f.directory, 'second-upstream');
  await initRepo(second);
  await mkdir(join(second, 'lib'));
  await writeFile(join(second, 'lib/format.rs'), 'pub fn width() -> u32 { 8 }\n');
  const secondBaseline = await commit(second, 'initial second upstream');
  await jsonWrite(join(f.hub, 'ports', 'demo', 'upstreams', 'format.json'), {
    upstream: { repository: second, ref: 'main' }, start: secondBaseline,
    selections: [{ id: 'width', description: 'Keep the format width aligned.', upstreamPaths: ['lib/**'], targetPaths: ['src/format.mjs'], acceptance: ['Width matches upstream.'] }],
  });
  await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  await writeFile(join(second, 'lib/format.rs'), 'pub fn width() -> u32 { 12 }\n');
  await commit(second, 'wider');
  await tag(second, 'v3.0.0');
  const [outcome] = await runHub(f.hub, { github: f.github, invoke: async (root, config) => {
    if (config.selections[0]!.id === 'width') {
      await writeFile(join(root, 'src/format.mjs'), 'export const width = 12;\n');
      await jsonWrite(join(root, '.oc-port/result.json'), { summary: 'Width ported.', decisions: [{ selection: 'width', status: 'applied', reason: 'Width is now 12.' }] });
    } else await port(2)(root);
  } });
  assert.equal(outcome!.status, 'proposal');
  const [pr] = f.github.prs;
  assert.equal(pr!.title, 'Port 2 upstreams: client v1.1.0, format v3.0.0');
  assert.deepEqual((await git(f.bare, ['log', '--format=%s', `main..${pr!.head}`])).trim().split('\n'), ['Port format v3.0.0', 'Port client v1.1.0']);
  Object.assign(pr!, { state: 'closed', merged: true });
  await runHub(f.hub, { github: f.github, invoke: mustNotInvoke });
  const recorded = await state(f.hub);
  assert.deepEqual([recorded.upstreams.client!.release, recorded.upstreams.format!.release], ['v1.1.0', 'v3.0.0']);
});
test('hub check previews without GitHub or a model', async t => {
  const f = await hubFixture(t);
  await changeUpstream(f.upstream, 2);
  await tag(f.upstream, 'v1.1.0');
  const [entry] = await checkHub(f.hub) as { sources: { status: string; release: string }[] }[];
  assert.deepEqual([entry!.sources[0]!.status, entry!.sources[0]!.release], ['will port', 'v1.1.0']);
});
test('hub init scaffolds a port folder, and its placeholders stop the run until filled in', async t => {
  const f = await hubFixture(t);
  await main(['hub', 'init', 'web', '--hub', f.hub, '--target', 'kyeshmz/web', '--upstream', 'https://github.com/org/Some.Lib.git', '--tags', 'v2.*'], f.directory);
  const upstream = JSON.parse(await readFile(join(f.hub, 'ports', 'web', 'upstreams', 'some.lib.json'), 'utf8'));
  assert.deepEqual(upstream.upstream, { repository: 'https://github.com/org/Some.Lib.git', ref: 'main', track: 'releases', tags: 'v2.*' });
  assert.equal(upstream.start, 'adopt');
  assert.match(await readFile(join(f.hub, 'ports', 'web', 'notes.md'), 'utf8'), /## How we differ/);
  assert.match((await runHub(f.hub, { port: 'web', github: f.github, invoke: mustNotInvoke }))[0]!.message!, /Replace the EDIT ME placeholders/);
  await assert.rejects(initPort(f.hub, 'web', { target: 'kyeshmz/web', upstream: 'https://github.com/org/lib.git' }), /already exists/);
  await assert.rejects(main(['hub', 'run', '--target', 'x/y', '--hub', f.hub], f.directory), /--target is not valid for hub run/);
});
