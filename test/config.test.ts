import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, parseConfig, parseState, policyHash, selected } from '../src/config.js';
import { agentDefinition, parseReport } from '../src/agent.js';
import { remoteRepository } from '../src/github.js';
import { config, configInput, plan } from './helpers.js';

test('globs handle root files, nested directories, exact paths and literal punctuation', () => {
  assert.ok(matches('src/client.ts', 'src/**'));
  assert.ok(matches('src/a/client.ts', 'src/**/*.ts'));
  assert.ok(matches('src/client.ts', 'src/**/*.ts'));
  assert.ok(matches('AGENTS.md', '**/AGENTS.md'));
  assert.ok(matches('src/client.ts', 'src/client.?s'));
  assert.ok(!matches('src/a/client.ts', 'src/*.ts'));
  assert.ok(!matches('src/clientXts', 'src/client.ts'));
});
test('selection exclusions override watched paths', () => {
  const selection = config().selections[0]!;
  selection.excludeUpstreamPaths = ['src/generated/**'];
  assert.ok(selected('src/client.rs', selection));
  assert.ok(!selected('src/generated/client.rs', selection));
});
test('configuration rejects misspelled fields, dangerous URLs, refs, globs and missing verification', () => {
  assert.throws(() => parseConfig({ ...configInput(), verfication: [] }), /Unknown/);
  assert.throws(() => parseConfig({ ...configInput(), verification: [] }), /verification/);
  assert.throws(() => parseConfig({ ...configInput(), upstream: { repository: 'https://token@github.com/a/b', ref: 'main' } }), /credentials/);
  assert.throws(() => parseConfig({ ...configInput(), upstream: { repository: '/upstream', ref: 'main~1' } }), /branch name/);
  const input = configInput();
  (input.selections as Record<string, unknown>[])[0]!.targetPaths = ['../outside/**'];
  assert.throws(() => parseConfig(input), /repository-relative/);
});
test('editor JSON schema references are accepted but do not change tracking semantics', () => {
  const original = parseConfig(configInput());
  const withSchema = parseConfig({ ...configInput(), $schema: './node_modules/oc-port-agent/schema/oc-port-agent.schema.json' });
  assert.equal(policyHash(original), policyHash(withSchema));
  assert.throws(() => parseConfig({ ...configInput(), $schema: {} }), /schema/);
});
test('policy changes require an explicit baseline, but model changes do not', () => {
  const original = config();
  const state = { version: 1, upstream: { ref: 'main', repository: '/upstream' }, policyHash: policyHash(original), lastSyncedCommit: 'a'.repeat(40) };
  assert.doesNotThrow(() => parseState(state, original));
  original.opencode.model = 'provider/model';
  assert.doesNotThrow(() => parseState(state, original));
  original.preserve.push('New invariant');
  assert.throws(() => parseState(state, original), /Tracking policy changed/);
});
test('reports require a complete unique decision for every selection and stop on blockers', () => {
  assert.throws(() => parseReport({ summary: 'Done', decisions: [] }, plan()), /omitted/);
  assert.throws(() => parseReport({ summary: 'Done', decisions: [{ selection: 'unknown', status: 'applied', reason: 'x' }] }, plan()), /unique/);
  assert.throws(() => parseReport({ summary: 'Blocked', decisions: [{ selection: 'retry-policy', status: 'blocked', reason: 'Ambiguous behavior' }] }, plan()), /blocker/);
  assert.equal(parseReport({ summary: 'Done', decisions: [{ selection: 'retry-policy', status: 'skipped', reason: 'Already equivalent' }] }, plan()).decisions[0]!.status, 'skipped');
});
test('generated OpenCode V2 agent denies shell, network, subagents, MCP and checkpoint edits', () => {
  const definition = agentDefinition(config());
  const metadata = { mode: /mode: (\w+)/.exec(definition)?.[1], permissions: [...definition.matchAll(/action: (".*")\n    resource: (".*")\n    effect: (\w+)/g)].map(match => ({ action: JSON.parse(match[1]!), resource: JSON.parse(match[2]!), effect: match[3]! })) };
  // OpenCode permissions use whole-value wildcards, unlike the host's path globs.
  const permissionMatches = (value: string, pattern: string): boolean => matches(value, pattern.replaceAll('**', '*').replaceAll('*', '**'));
  const effect = (action: string, resource: string): string | undefined => metadata.permissions.filter((r: { action: string; resource: string }) => permissionMatches(action, r.action) && permissionMatches(resource, r.resource)).at(-1)?.effect;
  assert.equal(metadata.mode, 'primary');
  assert.equal(effect('shell', 'git push origin main'), 'deny');
  assert.equal(effect('subagent', 'general'), 'deny');
  assert.equal(effect('github_create_pull_request', '*'), 'deny');
  assert.equal(effect('webfetch', 'https://example.com'), 'deny');
  assert.equal(effect('edit', '.oc-port/state.json'), 'deny');
  assert.equal(effect('edit', '.oc-port/result.json'), 'allow');
  assert.equal(effect('edit', 'src/client.mjs'), 'allow');
});
test('GitHub remotes are normalized without accepting another host', () => {
  assert.equal(remoteRepository('https://github.com/org/repo.git'), 'org/repo');
  assert.equal(remoteRepository('git@github.com:org/repo.git'), 'org/repo');
  assert.equal(remoteRepository('ssh://git@github.com/org/repo.git'), 'org/repo');
  assert.equal(remoteRepository('https://github.com.attacker.invalid/org/repo.git'), undefined);
});
