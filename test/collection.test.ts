import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { agentDefinition } from '../src/agent.js';
import { parseCollection, planCollection } from '../src/collection.js';
import { checkpointPath, loadConfig, policyHash, protectedEdit, STATE } from '../src/config.js';
import { main } from '../src/cli.js';
import { git, run } from '../src/process.js';
import { synchronize } from '../src/sync.js';
import { initialize, jsonWrite, planSync, setBaseline } from '../src/upstream.js';
import { changeUpstream, commit, configInput, fixture, report } from './helpers.js';

async function collectionFixture(t: TestContext) {
  const first = await fixture(t);
  const second = await fixture(t);
  await mkdir(join(first.target, 'policies'));
  const policy = configInput(second.upstream);
  (policy.selections as { targetPaths: string[] }[])[0]!.targetPaths = ['src/second.mjs'];
  policy.verification = [{ command: process.execPath, args: ['-e', "import('./src/second.mjs').then(({retries}) => { if (retries < 1) process.exit(1); })"] }];
  await writeFile(join(first.target, 'src/second.mjs'), 'export const retries = 1;\n');
  await jsonWrite(join(first.target, 'policies/second.json'), policy);
  await setBaseline(first.target, second.baseline, 'policies/second.json');
  await jsonWrite(join(first.target, 'ports.json'), { version: 1, policies: ['oc-port-agent.json', 'policies/second.json'] });
  await commit(first.target, 'Configure two source collection');
  return { ...first, second, secondConfig: await loadConfig(first.target, 'policies/second.json') };
}

test('collection validation is strict, ordered, bounded, and rejects ambiguous paths', () => {
  assert.deepEqual(parseCollection({ version: 1, policies: ['b.json', 'a.json'] }).policies, ['b.json', 'a.json']);
  for (const value of [null, [], {}, { version: 2, policies: ['a.json'] }, { version: 1, policies: [] }, { version: 1, policies: ['a', 'a'] }, { version: 1, policies: Array.from({ length: 101 }, (_, i) => `${i}.json`) }, { version: 1, policies: ['a'], upstream: {} }]) assert.throws(() => parseCollection(value));
  for (const path of ['../a.json', '/a.json', './a.json', 'a//b.json', 'a/*.json', 'a\\b.json']) assert.throws(() => parseCollection({ version: 1, policies: [path] }));
});

test('collection editor schema agrees with runtime path and list validation', async () => {
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(JSON.parse(await readFile('schema/oc-port-agent.collection.schema.json', 'utf8')));
  assert.ok(validate(JSON.parse(await readFile('examples/ports.json', 'utf8'))));
  for (const path of ['a.json', 'policies/a.json', '.policies/a.json', '../a.json', 'a/../b.json', './a.json', 'a/./b.json', '/a.json', 'a//b.json', 'a/*.json', 'a\\b.json', 'a\u0001.json']) {
    const input = { version: 1, policies: [path] };
    let accepted = true;
    try { parseCollection(input); } catch { accepted = false; }
    assert.equal(validate(input), accepted, path);
  }
  assert.equal(validate({ version: 1, policies: ['a', 'a'] }), false);
});

test('collection check pins independent repositories without changing checkpoints or policy hashes', async t => {
  const f = await collectionFixture(t);
  const firstHead = await changeUpstream(f.upstream, 2);
  const secondHead = await changeUpstream(f.second.upstream, 3);
  const checkpointBefore = await readFile(join(f.target, STATE), 'utf8');
  const originalHash = policyHash(await loadConfig(f.target));
  const { sources } = await planCollection(f.target, 'ports.json');
  assert.deepEqual(sources.map(s => s.plan.to), [firstHead, secondHead]);
  assert.deepEqual(sources.map(s => s.plan.from), [f.baseline, f.second.baseline]);
  assert.equal(policyHash(sources[0]!.config), originalHash);
  assert.equal(await readFile(join(f.target, STATE), 'utf8'), checkpointBefore);
  for (const source of sources) for (const path of ['ports.json', 'oc-port-agent.json', 'policies/second.json']) {
    assert.ok(protectedEdit(path, source.config));
    assert.ok(agentDefinition(source.config).includes(`resource: ${JSON.stringify(path)}\n    effect: deny`));
  }
});

test('multiple source repos produce one verified proposal and activate independent checkpoints only on merge', async t => {
  const f = await collectionFixture(t);
  const firstHead = await changeUpstream(f.upstream, 2);
  const secondHead = await changeUpstream(f.second.upstream, 3);
  const callerHead = (await git(f.target, ['rev-parse', 'HEAD'])).trim();
  const invoked: string[] = [];
  const result = await synchronize(f.target, { collection: 'ports.json', invoke: async (root, config, packet) => {
    invoked.push(config.upstream.repository);
    const data = JSON.parse(await readFile(packet, 'utf8'));
    assert.equal(data.upstream.repository, config.upstream.repository);
    if (config.upstream.repository === f.upstream) await writeFile(join(root, 'src/client.mjs'), 'export const retries = 2;\n');
    else {
      assert.match(await readFile(join(root, 'src/client.mjs'), 'utf8'), /retries = 2/);
      await writeFile(join(root, 'src/second.mjs'), 'export const retries = 3;\n');
    }
    await report(root);
  } });
  assert.equal(result.status, 'proposal');
  assert.deepEqual(invoked, [f.upstream, f.second.upstream]);
  assert.equal(result.sources?.length, 2);
  const evidence = JSON.parse(await readFile(join(result.worktree!, result.report!), 'utf8'));
  assert.equal(evidence.collection, 'ports.json');
  assert.equal(evidence.targetBase, callerHead);
  assert.equal(evidence.verification.length, 2);
  assert.ok(evidence.verification.every((source: { results: { code: number }[] }) => source.results.every(check => check.code === 0)));
  assert.equal((await git(f.target, ['rev-parse', 'HEAD'])).trim(), callerHead);
  assert.equal((await planSync(f.target)).plan.from, f.baseline);
  assert.equal((await planSync(f.target, false, 'policies/second.json')).plan.from, f.second.baseline);
  assert.equal(JSON.parse(await readFile(join(result.worktree!, STATE), 'utf8')).lastSyncedCommit, firstHead);
  assert.equal(JSON.parse(await readFile(join(result.worktree!, checkpointPath(f.secondConfig)), 'utf8')).lastSyncedCommit, secondHead);
  await git(f.target, ['merge', '--ff-only', result.branch!]);
  const noop = await synchronize(f.target, { collection: 'ports.json', invoke: async () => { throw new Error('Must not call a model'); } });
  assert.equal(noop.status, 'up-to-date');
  assert.ok(noop.sources?.every(source => source.status === 'up-to-date'));
  assert.equal((await git(f.target, ['status', '--porcelain'])).trim(), '');
});

test('unchanged sources are not adapted but are included in combined verification', async t => {
  const f = await collectionFixture(t);
  await changeUpstream(f.second.upstream, 4);
  let calls = 0;
  const result = await synchronize(f.target, { collection: 'ports.json', invoke: async (root, config) => {
    calls++;
    assert.equal(config.upstream.repository, f.second.upstream);
    await writeFile(join(root, 'src/second.mjs'), 'export const retries = 4;\n');
    await report(root);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.sources?.map(source => source.status), ['up-to-date', 'proposal']);
  const evidence = JSON.parse(await readFile(join(result.worktree!, result.report!), 'utf8'));
  assert.equal(evidence.verification.length, 2);
});

test('combined verification restores each source pinned packet, including unchanged policies', async t => {
  const f = await collectionFixture(t);
  for (const [file, repository, baseline] of [
    ['oc-port-agent.json', f.upstream, f.baseline],
    ['policies/second.json', f.second.upstream, f.second.baseline],
  ] as const) {
    const policy = JSON.parse(await readFile(join(f.target, file), 'utf8'));
    policy.verification.push({ command: process.execPath, args: ['-e', `const assert = require('node:assert/strict'); const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('.oc-port/context/packet.json', 'utf8')); assert.equal(p.upstream.repository, ${JSON.stringify(repository)}); assert.equal(p.plan.to, require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ${JSON.stringify(repository)}, encoding: 'utf8'}).trim());`] });
    await jsonWrite(join(f.target, file), policy);
    await setBaseline(f.target, baseline, file);
  }
  await commit(f.target);
  // The unchanged first source still needs its own context for final verification.
  await changeUpstream(f.second.upstream, 3);
  const result = await synchronize(f.target, { collection: 'ports.json', invoke: async root => {
    await writeFile(join(root, 'src/second.mjs'), 'export const retries = 3;\n');
    await report(root);
  } });
  assert.equal(result.status, 'proposal');
  assert.deepEqual(result.sources?.map(source => source.status), ['up-to-date', 'proposal']);
});

test('full collection adoption runs even when every upstream is unchanged', async t => {
  const f = await collectionFixture(t);
  let calls = 0;
  const result = await synchronize(f.target, { collection: 'ports.json', full: true, invoke: async root => {
    calls++;
    await report(root, 'skipped', 'Already equivalent to the selected source.');
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'proposal');
  assert.ok(result.sources?.every(source => source.from === source.to));
});

test('a missing or invalid later policy fails before the first model call or worktree', async t => {
  const f = await collectionFixture(t);
  await changeUpstream(f.upstream);
  await jsonWrite(join(f.target, 'ports.json'), { version: 1, policies: ['oc-port-agent.json', 'missing.json'] });
  await commit(f.target);
  const before = await git(f.target, ['worktree', 'list', '--porcelain']);
  await assert.rejects(synchronize(f.target, { collection: 'ports.json', invoke: async () => { throw new Error('Unexpected model call'); } }), /ENOENT/);
  assert.equal(await git(f.target, ['worktree', 'list', '--porcelain']), before);
});

test('later source failure never changes the caller or advances its earlier checkpoint', async t => {
  const f = await collectionFixture(t);
  await changeUpstream(f.upstream, 2);
  await changeUpstream(f.second.upstream, 3);
  await assert.rejects(synchronize(f.target, { collection: 'ports.json', invoke: async (root, config) => {
    await writeFile(join(root, config.upstream.repository === f.upstream ? 'src/client.mjs' : 'src/second.mjs'), `export const retries = ${config.upstream.repository === f.upstream ? 2 : -1};\n`);
    await report(root);
  } }), /Verification failed.*Proposal worktree preserved/s);
  assert.equal((await planSync(f.target)).plan.from, f.baseline);
  assert.equal((await planSync(f.target, false, 'policies/second.json')).plan.from, f.second.baseline);
  assert.match(await readFile(join(f.target, 'src/client.mjs'), 'utf8'), /retries = 1/);
});

test('final verification catches a later overlapping port breaking an earlier source', async t => {
  const f = await collectionFixture(t);
  const policy = JSON.parse(await readFile(join(f.target, 'policies/second.json'), 'utf8'));
  policy.selections[0].targetPaths.push('src/client.mjs');
  await jsonWrite(join(f.target, 'policies/second.json'), policy);
  await setBaseline(f.target, f.second.baseline, 'policies/second.json');
  await commit(f.target);
  await changeUpstream(f.upstream, 2);
  await changeUpstream(f.second.upstream, 3);
  await assert.rejects(synchronize(f.target, { collection: 'ports.json', invoke: async (root, config) => {
    if (config.upstream.repository === f.upstream) await writeFile(join(root, 'src/client.mjs'), 'export const retries = 2;\n');
    else {
      await writeFile(join(root, 'src/second.mjs'), 'export const retries = 3;\n');
      await writeFile(join(root, 'src/client.mjs'), 'export const retries = -1;\n');
    }
    await report(root);
  } }), /Combined verification failed for oc-port-agent.json/);
  assert.equal((await planSync(f.target)).plan.from, f.baseline);
});

test('a policy cannot edit another policy or the collection even with broad target globs', async t => {
  for (const path of ['ports.json', 'policies/second.json']) {
    const f = await collectionFixture(t);
    const policy = JSON.parse(await readFile(join(f.target, 'oc-port-agent.json'), 'utf8'));
    policy.selections[0].targetPaths = ['**'];
    await jsonWrite(join(f.target, 'oc-port-agent.json'), policy);
    await setBaseline(f.target, f.baseline);
    await commit(f.target);
    await changeUpstream(f.upstream);
    await assert.rejects(synchronize(f.target, { collection: 'ports.json', invoke: async root => {
      await writeFile(join(root, path), '{}');
      await report(root);
    } }), new RegExp(`protected edit: ${path.replaceAll('.', '\\.')}`));
  }
});

test('each port keeps its own edit scope rather than a union of all source scopes', async t => {
  const f = await collectionFixture(t);
  await changeUpstream(f.upstream, 2);
  await changeUpstream(f.second.upstream, 3);
  await assert.rejects(synchronize(f.target, { collection: 'ports.json', invoke: async (root, config) => {
    await writeFile(join(root, 'src/client.mjs'), `export const retries = ${config.upstream.repository === f.upstream ? 2 : 3};\n`);
    await report(root);
  } }), /Out-of-scope or protected edit: src\/client.mjs/);
});

test('collection paths reject traversal, symlink aliases and self-reference', async t => {
  const f = await collectionFixture(t);
  await assert.rejects(planCollection(f.target, '../ports.json'), /exact repository-relative/);
  await symlink('ports.json', join(f.target, 'alias.json'));
  await assert.rejects(planCollection(f.target, 'alias.json'), /symlink/);
  await symlink('second.json', join(f.target, 'policies/alias.json'));
  await jsonWrite(join(f.target, 'ports.json'), { version: 1, policies: ['policies/alias.json'] });
  await assert.rejects(planCollection(f.target, 'ports.json'), /symlink/);
  await jsonWrite(join(f.target, 'ports.json'), { version: 1, policies: ['ports.json'] });
  await assert.rejects(planCollection(f.target, 'ports.json'), /itself/);
});

test('CLI exposes collection previews and rejects conflicting selectors', async t => {
  const f = await collectionFixture(t);
  const outcome = await run(process.execPath, [join(import.meta.dirname, '../src/cli.js'), 'check', '--collection', 'ports.json'], f.target);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(JSON.parse(outcome.stdout).sources.length, 2);
  await assert.rejects(main(['check', '--config', 'a.json', '--collection', 'ports.json'], f.target), /cannot be combined/);
  await assert.rejects(synchronize(f.target, { config: 'a.json', collection: 'ports.json' }), /cannot be combined/);
});

test('init scaffolds additional policies without overwriting files or duplicating ignore rules', async t => {
  const f = await fixture(t);
  const ignore = await readFile(join(f.target, '.gitignore'), 'utf8');
  await initialize(f.target, f.upstream, 'main', 'ports/retry.json');
  assert.equal((await loadConfig(f.target, 'ports/retry.json')).upstream.repository, f.upstream);
  assert.equal(await readFile(join(f.target, '.gitignore'), 'utf8'), ignore);
  await assert.rejects(initialize(f.target, f.upstream, 'main', 'ports/retry.json'), /not overwritten/);
  await symlink(f.directory, join(f.target, 'outside'));
  await assert.rejects(initialize(f.target, f.upstream, 'main', 'outside/nested/policy.json'), /symlink/);
});
