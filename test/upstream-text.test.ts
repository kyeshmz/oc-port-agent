import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, STATE } from '../src/config.js';
import { writePacket } from '../src/agent.js';
import { git, runBytes } from '../src/process.js';
import { synchronize } from '../src/sync.js';
import { jsonWrite, planSync, setBaseline } from '../src/upstream.js';
import { commit, configInput, fixture, report } from './helpers.js';

const sourcePath = 'src/spectrum.ts';
const source = Buffer.from('\ufeff// Literal replacement character: \ufffd; Unicode: café 😀 e\u0301\r\nconst key = `${platform}\0${channel}`;\r\n');

async function configure(target: string, upstream: string, baseline: string, allowNulTextPaths: string[] = []): Promise<void> {
  await jsonWrite(join(target, CONFIG), { ...configInput(upstream), allowNulTextPaths });
  await setBaseline(target, baseline);
  await commit(target, 'review source-reading policy');
}

test('literal NUL source is rejected by default without changing the checkpoint', async t => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, sourcePath), source);
  await commit(f.upstream);
  const checkpoint = await readFile(join(f.target, STATE));
  await assert.rejects(planSync(f.target, true), /binary or non-UTF-8.*src\/spectrum\.ts/);
  assert.deepEqual(await readFile(join(f.target, STATE)), checkpoint);
});

test('exact NUL allowance preserves full adoption and changed before/after bytes through the JSON packet', async t => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, sourcePath), source);
  const baseline = await commit(f.upstream);
  await configure(f.target, f.upstream, baseline, [sourcePath]);
  const { config, plan } = await planSync(f.target, true);
  assert.equal(plan.mode, 'adopt');
  assert.equal(plan.from, baseline);
  assert.equal(plan.to, baseline);
  for (const files of [plan.before, plan.after]) {
    assert.deepEqual(Buffer.from(files.find(file => file.path === sourcePath)!.content), source);
  }
  const definition = await writePacket(f.target, config, plan);
  const json = await readFile(definition, 'utf8');
  assert.ok(json.includes('\\u0000'), 'JSON escapes NUL without modifying the source string');
  const packet = JSON.parse(json);
  assert.deepEqual(packet.policy.allowNulTextPaths, [sourcePath]);
  assert.deepEqual(Buffer.from(packet.plan.before.find((file: { path: string }) => file.path === sourcePath).content), source);

  const adoption = await synchronize(f.target, { full: true, invoke: async (root, _config, path) => {
    const adopted = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Buffer.from(adopted.plan.after.find((file: { path: string }) => file.path === sourcePath).content), source);
    await writeFile(join(root, 'src/client.mjs'), 'export const retries = 1;\nexport const retryEnabled = true;\n');
    await report(root);
  } });
  assert.equal(adoption.status, 'proposal');

  const changed = Buffer.concat([source, Buffer.from('// changed behavior\n')]);
  await writeFile(join(f.upstream, sourcePath), changed);
  const head = await commit(f.upstream);
  const next = await planSync(f.target);
  const changedPacket = JSON.parse(await readFile(await writePacket(f.target, next.config, next.plan), 'utf8'));
  assert.equal(changedPacket.plan.from, baseline);
  assert.equal(changedPacket.plan.to, head);
  assert.ok(changedPacket.plan.changedPaths.includes(sourcePath));
  assert.deepEqual(Buffer.from(changedPacket.plan.before.find((file: { path: string }) => file.path === sourcePath).content), source);
  assert.deepEqual(Buffer.from(changedPacket.plan.after.find((file: { path: string }) => file.path === sourcePath).content), changed);
  assert.equal(JSON.parse(await readFile(join(f.target, STATE), 'utf8')).lastSyncedCommit, baseline);
});

test('a deleted allowlisted source still supplies exact before-context', async t => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, sourcePath), source);
  const baseline = await commit(f.upstream);
  await configure(f.target, f.upstream, baseline, [sourcePath]);
  await rm(join(f.upstream, sourcePath));
  await commit(f.upstream);
  const { plan } = await planSync(f.target);
  assert.deepEqual(Buffer.from(plan.before.find(file => file.path === sourcePath)!.content), source);
  assert.ok(!plan.after.some(file => file.path === sourcePath));
});

test('invalid original UTF-8 bytes are rejected even with an exact NUL allowance', async t => {
  const f = await fixture(t);
  await configure(f.target, f.upstream, f.baseline, [sourcePath]);
  for (const invalid of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
    await writeFile(join(f.upstream, sourcePath), Buffer.from([0, ...invalid]));
    await commit(f.upstream);
    await assert.rejects(planSync(f.target, true), /non-UTF-8.*src\/spectrum\.ts/);
  }
});

test('literal U+FFFD is valid text without opting in to NUL', async t => {
  const f = await fixture(t);
  const text = Buffer.from('\ufeffconst replacement = "\ufffd";\n');
  await writeFile(join(f.upstream, sourcePath), text);
  await commit(f.upstream);
  const { plan } = await planSync(f.target);
  assert.deepEqual(Buffer.from(plan.after.find(file => file.path === sourcePath)!.content), text);
});

test('invalid UTF-8 without NUL is also rejected by default', async t => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, sourcePath), Buffer.from([0xff]));
  await commit(f.upstream);
  await assert.rejects(planSync(f.target), /non-UTF-8.*src\/spectrum\.ts/);
});

test('an existing checkpoint cannot silently acquire a NUL text allowance', async t => {
  const f = await fixture(t);
  const checkpoint = await readFile(join(f.target, STATE));
  await jsonWrite(join(f.target, CONFIG), { ...configInput(f.upstream), allowNulTextPaths: [sourcePath] });
  await assert.rejects(planSync(f.target, true), /Tracking policy changed.*baseline --commit/);
  assert.deepEqual(await readFile(join(f.target, STATE)), checkpoint);
});

test('NUL allowance does not cover neighboring binary files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, sourcePath), source);
  await writeFile(join(f.upstream, 'src/unrelated.bin'), Buffer.from([0, 1, 2, 3]));
  const baseline = await commit(f.upstream);
  await configure(f.target, f.upstream, baseline, [sourcePath]);
  await assert.rejects(planSync(f.target, true), /binary or non-UTF-8.*src\/unrelated\.bin/);
});

test('an exact allowance cannot read through an upstream symlink or gitlink', async t => {
  const f = await fixture(t);
  await symlink('/outside/repository', join(f.upstream, sourcePath));
  const baseline = await commit(f.upstream);
  await configure(f.target, f.upstream, baseline, [sourcePath]);
  await assert.rejects(planSync(f.target, true), /symlink\/submodule.*src\/spectrum\.ts/);
  await rm(join(f.upstream, sourcePath));
  await git(f.upstream, ['add', '-A']);
  await git(f.upstream, ['update-index', '--add', '--cacheinfo', `160000,${baseline},${sourcePath}`]);
  await git(f.upstream, ['commit', '-m', 'replace symlink with gitlink']);
  const head = (await git(f.upstream, ['rev-parse', 'HEAD'])).trim();
  await configure(f.target, f.upstream, head, [sourcePath]);
  await assert.rejects(planSync(f.target, true), /symlink\/submodule.*src\/spectrum\.ts/);
});

test('raw output uses the same command limits and reports incomplete reads as failures', async () => {
  const bytes = await runBytes(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,239,187,191]))'], process.cwd());
  assert.equal(bytes.code, 0);
  assert.deepEqual(bytes.stdout, Buffer.from([0, 255, 239, 187, 191]));
  const oversized = await runBytes(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024))'], process.cwd());
  assert.notEqual(oversized.code, 0);
  assert.match(oversized.stderr, /exceeded 16 MiB/);
  const timedOut = await runBytes(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), 0.1);
  assert.notEqual(timedOut.code, 0);
  assert.match(timedOut.stderr, /timed out/);
});
