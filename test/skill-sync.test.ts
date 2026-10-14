import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointPath, loadConfig, parseConfig, policyHash, protectedEdit } from '../src/config.js';
import { agentDefinition } from '../src/agent.js';
import { explicitInvocation, skillGate, synchronize } from '../src/sync.js';
import { planSync } from '../src/upstream.js';
import { git } from '../src/process.js';
import { changeUpstream, commit, configInput, fixture } from './helpers.js';

const skill = (text = 'Original'): string => `---\nname: sample\ndescription: Sample\nmetadata:\n  opencode/autoinvoke: false\n---\n${text}\n`;
function input(repository = '/upstream'): Record<string, unknown> {
  return { ...configInput(repository), allowSkillEdits: ['sample'], selections: [{
    id: 'sample', description: 'Maintain this explicitly invoked skill.', upstreamPaths: ['src/**'],
    targetPaths: ['.opencode/skills/sample/**'], acceptance: ['Keep the skill explicitly invoked.'],
  }] };
}

test('skill opt-in is exact, explicit, and changes the policy hash', () => {
  const legacy = parseConfig(configInput());
  assert.equal(protectedEdit('.opencode/skills/sample/SKILL.md', legacy), true);
  const enabled = parseConfig(input());
  assert.equal(protectedEdit('.opencode/skills/sample/SKILL.md', enabled), false);
  for (const path of ['.opencode/agents/a.md', '.opencode/opencode.jsonc', '.opencode/skills/other/SKILL.md', '.opencode/skills/sample/opencode.json', '.opencode/skills/sample/.opencode/agents/a.md', '.oc-port/state.json']) {
    assert.equal(protectedEdit(path, enabled), true, path);
  }
  for (const ids of [['*'], ['../sample'], ['sample', 'sample'], ['missing']]) assert.throws(() => parseConfig({ ...input(), allowSkillEdits: ids }));
  const withoutOptIn = parseConfig({ ...input(), allowSkillEdits: [] });
  assert.notEqual(policyHash(withoutOptIn), policyHash(enabled));
  assert.throws(() => parseConfig({ ...input(), baselineCommit: 'HEAD' }), /immutable/);
});

test('explicit invocation checks hierarchy, duplicate fields, and V2 precedence', () => {
  assert.equal(explicitInvocation(skill()), true);
  assert.equal(explicitInvocation('---\ndisable-model-invocation: true\n---\nbody'), true);
  for (const header of [
    'description: |\n  opencode/autoinvoke: false',
    'metadata:\n  note: |\n    opencode/autoinvoke: false',
    'metadata:\n  opencode/autoinvoke: false\n  opencode/autoinvoke: true',
    'metadata:\n  opencode/autoinvoke: false\nmetadata:\n  opencode/autoinvoke: true',
    'disable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true',
    "metadata:\n  opencode/autoinvoke: false\n  'opencode/autoinvoke': true",
  ]) assert.equal(explicitInvocation(`---\n${header}\n---\nbody`), false, header);
});

test('generated permissions grant only the selected skill and still deny execution', () => {
  const config = parseConfig(input());
  const rules = [...agentDefinition(config).matchAll(/action: (".*")\n    resource: (".*")\n    effect: (\w+)/g)].map(m => ({ action: JSON.parse(m[1]!), resource: JSON.parse(m[2]!), effect: m[3] }));
  const at = (action: string, resource: string): string | undefined => rules.filter(rule => {
    const matches = (value: string, pattern: string): boolean => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*') + '$').test(value);
    return matches(action, rule.action) && matches(resource, rule.resource);
  }).at(-1)?.effect;
  assert.equal(at('edit', '.opencode/skills/sample/SKILL.md'), 'allow');
  assert.equal(at('edit', '.opencode/agents/a.md'), 'deny');
  assert.equal(at('edit', '.opencode/skills/sample/opencode.jsonc'), 'deny');
  assert.equal(at('skill', 'sample'), 'deny');
  assert.equal(at('shell', 'anything'), 'deny');
});

test('each policy has an independent bootstrap/checkpoint and sync leaves the caller unchanged', async t => {
  const f = await fixture(t);
  await mkdir(join(f.target, 'policies'));
  await mkdir(join(f.target, '.opencode/skills/sample'), { recursive: true });
  await writeFile(join(f.target, '.opencode/skills/sample/SKILL.md'), skill());
  const policy = { ...input(f.upstream), baselineCommit: f.baseline, verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] };
  await writeFile(join(f.target, 'policies/one.json'), JSON.stringify(policy));
  await writeFile(join(f.target, 'policies/two.json'), JSON.stringify(policy));
  await commit(f.target, 'approved skill policies');
  const one = await loadConfig(f.target, 'policies/one.json');
  const two = await loadConfig(f.target, 'policies/two.json');
  assert.notEqual(checkpointPath(one), checkpointPath(two));
  const head = await changeUpstream(f.upstream);
  const check = await planSync(f.target, false, 'policies/one.json');
  assert.equal(check.plan.from, f.baseline);
  await assert.rejects(readFile(join(f.target, checkpointPath(one))), /ENOENT/);
  const result = await synchronize(f.target, { config: 'policies/one.json', invoke: async root => {
    await writeFile(join(root, '.opencode/skills/sample/SKILL.md'), skill('Adapted'));
    await writeFile(join(root, '.oc-port/result.json'), JSON.stringify({ summary: 'Adapted', decisions: [{ selection: 'sample', status: 'applied', reason: 'Updated selected skill.' }] }));
  } });
  assert.equal(result.status, 'proposal');
  assert.equal(JSON.parse(await readFile(join(result.worktree!, checkpointPath(one)), 'utf8')).lastSyncedCommit, head);
  await assert.rejects(readFile(join(f.target, checkpointPath(one))), /ENOENT/);
  assert.equal((await planSync(f.target, false, 'policies/two.json')).plan.from, f.baseline);
  await git(f.target, ['merge', '--ff-only', result.branch!]);
  assert.equal((await planSync(f.target, false, 'policies/one.json')).plan.from, head);
  assert.equal((await planSync(f.target, false, 'policies/two.json')).plan.from, f.baseline);
});

test('skill gate rejects nested registrations and symlink ancestors', async t => {
  const f = await fixture(t);
  const config = parseConfig(input(f.upstream));
  await mkdir(join(f.target, '.opencode/skills/sample/nested'), { recursive: true });
  await writeFile(join(f.target, '.opencode/skills/sample/nested/SKILL.md'), skill());
  await assert.rejects(skillGate(f.target, config), /Nested skill/);
  const other = await fixture(t);
  await mkdir(join(other.directory, 'outside'));
  await symlink(join(other.directory, 'outside'), join(other.target, '.opencode'));
  await assert.rejects(skillGate(other.target, config), /symlink/);
});
