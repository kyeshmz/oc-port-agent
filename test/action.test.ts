import test from 'node:test';
import assert from 'node:assert/strict';
import { actionInvocation } from '../src/action.js';
import { fixture, changeUpstream, report } from './helpers.js';
import { synchronize } from '../src/sync.js';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from '../src/config.js';

test('action passes the supplied API key through the chosen provider environment, never argv', () => {
  const invocation = actionInvocation({ OC_PORT_API_KEY: 'test-secret-not-a-real-key', OC_PORT_API_KEY_ENV: 'OPENAI_API_KEY', OC_PORT_MODEL: 'openai/example-model', OC_PORT_MODE: 'sync' });
  assert.equal(invocation.env.OPENAI_API_KEY, 'test-secret-not-a-real-key');
  assert.equal(invocation.env.OC_PORT_API_KEY, undefined);
  assert.deepEqual(invocation.args, ['sync', '--model', 'openai/example-model']);
  assert.ok(!invocation.args.join(' ').includes('test-secret'));
});
test('action supports the official provider-env convention and requires no key for a preview', () => {
  assert.equal(actionInvocation({ OPENCODE_API_KEY: 'test-key' }).env.OPENCODE_API_KEY, 'test-key');
  assert.equal(actionInvocation({ OC_PORT_API_KEY_ENV: 'ANTHROPIC_API_KEY', ANTHROPIC_API_KEY: 'test-key' }).env.ANTHROPIC_API_KEY, 'test-key');
  assert.deepEqual(actionInvocation({ OC_PORT_MODE: 'check' }).args, ['check']);
});
test('action refuses missing credentials, unsafe credential names and invalid publication modes', () => {
  assert.throws(() => actionInvocation({ OC_PORT_MODE: 'sync' }), /GitHub Secrets/);
  assert.throws(() => actionInvocation({ OC_PORT_API_KEY: 'test-key', OC_PORT_API_KEY_ENV: 'NODE_OPTIONS' }), /credential variable/);
  assert.throws(() => actionInvocation({ OC_PORT_API_KEY: 'test-key', OC_PORT_API_KEY_ENV: 'OPENCODE_SERVER_PASSWORD' }), /credential variable/);
  assert.throws(() => actionInvocation({ OC_PORT_MODE: 'check', OC_PORT_PUBLISH: 'true' }), /cannot publish/);
  assert.throws(() => actionInvocation({ OC_PORT_API_KEY: 'test-key', OC_PORT_PUBLISH: 'true' }), /repository and base/);
});
test('action model override and initial adoption map to explicit CLI arguments', () => {
  const invocation = actionInvocation({ OC_PORT_MODE: 'adopt', OC_PORT_API_KEY: 'test-key', OC_PORT_MODEL: 'provider/model#variant', OC_PORT_PUBLISH: 'true', OC_PORT_REPOSITORY: 'owner/repo', OC_PORT_BASE: 'main' });
  assert.deepEqual(invocation.args, ['sync', '--full', '--model', 'provider/model#variant', '--pr', '--repo', 'owner/repo', '--base', 'main']);
});
test('action routes a port collection to one combined proposal and rejects conflicting inputs', () => {
  assert.deepEqual(actionInvocation({ OC_PORT_MODE: 'check', OC_PORT_COLLECTION: 'ports.json' }).args, ['check', '--collection', 'ports.json']);
  assert.deepEqual(actionInvocation({ OC_PORT_MODE: 'adopt', OC_PORT_API_KEY: 'test-key', OC_PORT_COLLECTION: 'ports.json' }).args, ['sync', '--full', '--collection', 'ports.json']);
  assert.throws(() => actionInvocation({ OC_PORT_MODE: 'check', OC_PORT_CONFIG: 'a.json', OC_PORT_COLLECTION: 'ports.json' }), /cannot be combined/);
});
test('workflow passes credentials to oc-port-agent, not to checkout or the install step', async () => {
  const workflow = await readFile('examples/github-workflow.yml', 'utf8');
  const checkout = workflow.split('- name: Check out target base')[1]!.split('- name: Check or synchronize selected functionality')[0]!;
  assert.ok(!checkout.includes('api-key:'));
  const sync = workflow.split('- name: Check or synchronize selected functionality')[1]!;
  assert.match(sync, /api-key: \$\{\{ secrets\.OPENCODE_API_KEY \}\}/);
  assert.match(sync, /api-key-env: OPENCODE_API_KEY/);
  const action = await readFile('action.yml', 'utf8');
  const install = action.split('- name: Install OpenCode V2')[1]!.split('- name: Build oc-port-agent')[0]!;
  assert.ok(!install.includes('inputs.api-key'));
  assert.match(action, /OC_PORT_API_KEY: \$\{\{ inputs\.api-key \}\}/);
});
test('runtime model override reaches the runner without editing the tracking policy', async t => {
  const f = await fixture(t);
  await changeUpstream(f.upstream);
  const before = await readFile(join(f.target, CONFIG), 'utf8');
  await synchronize(f.target, { model: 'provider/model#variant', invoke: async (root, config) => {
    assert.equal(config.opencode.model, 'provider/model#variant');
    await writeFile(join(root, 'src/client.mjs'), 'export const retries = 2;\n');
    await report(root);
  } });
  assert.equal(await readFile(join(f.target, CONFIG), 'utf8'), before);
});
