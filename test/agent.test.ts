import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { startPrivateServer } from '../src/server.js';
import { agentDefinition, invokeOpenCode } from '../src/agent.js';
import { run } from '../src/process.js';
import { synchronize } from '../src/sync.js';
import { setBaseline } from '../src/upstream.js';
import { changeUpstream, commit, configInput, fixture } from './helpers.js';

test('actual CLI adapter uses V2 flags, strips publishing tokens and removes its temporary agent', async t => {
  const f = await fixture(t);
  await changeUpstream(f.upstream);
  const goal = 'Port cancellation-aware retry behavior into the target client.';
  const rawConfig = configInput(f.upstream);
  (rawConfig.selections as Record<string, unknown>[])[0]!.instructions = {
    goal,
    adaptation: ['Use the target AbortSignal API.'],
    nonGoals: ['Do not edit authentication helpers.'],
  };
  await writeFile(join(f.target, 'oc-port-agent.json'), JSON.stringify(rawConfig));
  await commit(f.target, 'add structured porting intent');
  await setBaseline(f.target, f.baseline);
  await commit(f.target, 'review structured intent baseline');
  const executable = join(f.directory, 'fake-opencode');
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const args = process.argv.slice(2);
if (args[0] === 'serve') {
  createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'oc-port-agent' }] })); }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
} else {
if (!args.includes('--server') || !args.includes('--file') || !args.includes('--agent')) process.exit(3);
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(4);
const packet = JSON.parse(readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
if (packet.plan.selections[0].id !== 'retry-policy') process.exit(5);
if (packet.policy.selections[0].instructions.goal !== ${JSON.stringify(goal)} || packet.policy.selections[0].instructions.adaptation[0] !== 'Use the target AbortSignal API.' || packet.policy.selections[0].instructions.nonGoals[0] !== 'Do not edit authentication helpers.') process.exit(7);
const agent = readFileSync('.opencode/agents/oc-port-agent.md', 'utf8');
if (!agent.includes('permissions:') || !agent.includes('trusted operator-authored task intent') || !agent.includes('report the conflict as blocked for operator review')) process.exit(6);
writeFileSync('src/client.mjs', 'export const retries = 2;\\n');
writeFileSync('.oc-port/result.json', JSON.stringify({ summary: 'Adapted retries', decisions: [{ selection: 'retry-policy', status: 'applied', reason: 'Adapted retries' }] }));
console.log(JSON.stringify({ type: 'text', text: 'Done' }));
}
`);
  await chmod(executable, 0o755);
  const result = await synchronize(f.target, { invoke: async (root, config, packet, failure) => {
    await invokeOpenCode(root, { ...config, opencode: { ...config.opencode, executable } }, packet, failure);
  } });
  await assert.rejects(readFile(join(result.worktree!, '.opencode/agents/oc-port-agent.md')), /ENOENT/);
  assert.match(await readFile(join(result.worktree!, '.oc-port/agent-output.log'), 'utf8'), /Done/);
});

test('adapter refuses to overwrite an existing agent', async t => {
  const f = await fixture(t);
  await mkdir(join(f.target, '.opencode/agents'), { recursive: true });
  const path = join(f.target, '.opencode/agents/oc-port-agent.md');
  await writeFile(path, 'Existing user agent');
  await assert.rejects(invokeOpenCode(f.target, f.config, '/unused'), /Refusing to overwrite/);
  assert.equal(await readFile(path, 'utf8'), 'Existing user agent');
});

test('process runner preserves nonzero exits and reports timeouts', async () => {
  assert.equal((await run(process.execPath, ['-e', 'process.exit(7)'], process.cwd())).code, 7);
  const timeout = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], process.cwd(), 0.1);
  assert.notEqual(timeout.code, 0);
  assert.match(timeout.stderr, /timed out/);
});

test('child PWD follows the proposal worktree, not the calling application', async t => {
  const f = await fixture(t);
  const cwd = await realpath(f.target);
  const result = await run(process.execPath, ['-e', 'console.log(JSON.stringify({cwd: process.cwd(), pwd: process.env.PWD}))'], cwd, 10, { ...process.env, PWD: '/wrong-parent-repository' });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { cwd, pwd: cwd });
});

test('installed OpenCode V2 can discover and parse the generated agent using a private server (no model call)', { skip: process.env.OC_PORT_TEST_OPENCODE !== '1' }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.target, '.opencode/agents'), { recursive: true });
  await writeFile(join(f.target, '.opencode/agents/oc-port-agent.md'), agentDefinition(f.config));
  const env = { ...process.env, OPENCODE_CONFIG_DIR: join(f.directory, 'config') };
  await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true });
  const server = await startPrivateServer('opencode', f.target, env, 60);
  await server.close();
});
