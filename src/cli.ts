#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { initialize, planSync, repositoryRoot, setBaseline } from './upstream.js';
import { synchronize } from './sync.js';
import { planCollection } from './collection.js';
import { checkHub, initPort, runHub } from './hub.js';
import type { Plan } from './upstream.js';

const HELP = `oc-port-agent — adopt and track selected upstream functionality using OpenCode V2

Run inside the target Git repository:
  oc-port-agent init --upstream https://github.com/org/source.git [--ref main] [--track releases|branch] [--tags 'v2.*'] [--config policies/source.json]
  oc-port-agent baseline --commit <upstream-SHA|HEAD>
  oc-port-agent check [--full]
  oc-port-agent sync [--full] [--model provider/model#variant] [--pr --repo owner/target --base main]
  check, baseline and sync accept --config <repository-relative-policy.json> for independently tracked upstreams.
  check and sync accept --collection <ports.json> to gather multiple policies into one target/proposal.

init writes a configurable tracking policy, not an implementation.
What to follow (policy "upstream" fields, or init flags):
  default          the newest stable release tag (v1.2.3); the --ref branch when the upstream has none
  --tags 'v2.*'    only releases whose tag matches, e.g. one major version or '@scope/pkg@*' in a monorepo
  --track branch   every commit on the --ref branch (e.g. --ref release/1.x) instead of releases
baseline explicitly acknowledges the starting point (HEAD = the tracked release or branch head); commit the policy and state.
check fetches and previews WITHOUT calling OpenCode or advancing the checkpoint.
sync --full adopts existing selected functionality, including on an unchanged upstream.
sync creates a local proposal worktree. --pr also pushes and creates a draft PR.
No automatic merging, no blind cherry-picking, no implicit GitHub publication.

Run inside a hub repository that ports upstream changes into many target repositories:
  oc-port-agent hub init <name> --target owner/repo --upstream https://github.com/org/source.git [--ref main] [--base main] [--track releases|branch] [--tags 'v2.*']
  oc-port-agent hub check [--port <name>]
  oc-port-agent hub run [--port <name>] [--model provider/model#variant]
hub init adds ports/<name>/ with target.json, upstreams/<id>.json and notes.md to fill in.
hub check previews every port WITHOUT GitHub calls, a model, or state changes.
hub run reconciles earlier PRs, ports new upstream changes and opens one draft PR per target.
It needs GH_TOKEN with contents and pull request write access to the targets. All accept --hub <dir> (default: here).
`;

const HUB_OPTIONS: Record<string, string[]> = {
  init: ['hub', 'target', 'upstream', 'ref', 'base', 'track', 'tags'],
  check: ['hub', 'port'],
  run: ['hub', 'port', 'model'],
};
async function hubMain(positionals: string[], values: Record<string, string | boolean | undefined>, cwd: string): Promise<void> {
  const [command, name, ...rest] = positionals;
  if (!command || !HUB_OPTIONS[command] || rest.length || (command === 'init') !== (name !== undefined)) throw new Error(HELP);
  for (const key of Object.keys(values)) if (!HUB_OPTIONS[command]!.includes(key)) throw new Error(`--${key} is not valid for hub ${command}`);
  const text = (key: string): string | undefined => values[key] as string | undefined;
  const hub = resolve(cwd, text('hub') ?? '.');
  if (command === 'init') {
    if (!text('target') || !text('upstream')) throw new Error('hub init requires --target owner/repo and --upstream <url>');
    const track = text('track');
    if (track !== undefined && track !== 'releases' && track !== 'branch') throw new Error('--track must be releases or branch');
    const directory = await initPort(hub, name!, {
      target: text('target')!, upstream: text('upstream')!,
      ...(text('ref') !== undefined ? { ref: text('ref')! } : {}), ...(text('base') !== undefined ? { base: text('base')! } : {}),
      ...(track !== undefined ? { track } : {}), ...(text('tags') !== undefined ? { tags: text('tags')! } : {}),
    });
    console.log(`Created ${directory}. Fill in the EDIT ME parts of upstreams/*.json, the tests in target.json, and notes.md.`);
  } else if (command === 'check') {
    console.log(JSON.stringify(await checkHub(hub, text('port')), null, 2));
  } else {
    const outcomes = await runHub(hub, { ...(text('port') !== undefined ? { port: text('port')! } : {}), ...(text('model') !== undefined ? { model: text('model')! } : {}) });
    console.log(JSON.stringify(outcomes, null, 2));
    const failed = outcomes.filter(outcome => outcome.status === 'error');
    if (failed.length) throw new Error(`${failed.length} port(s) failed: ${failed.map(outcome => `${outcome.port}: ${outcome.message}`).join('\n')}`);
  }
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    upstream: { type: 'string' }, ref: { type: 'string' }, track: { type: 'string' }, tags: { type: 'string' }, commit: { type: 'string' },
    full: { type: 'boolean' }, pr: { type: 'boolean' }, repo: { type: 'string' }, base: { type: 'string' },
    model: { type: 'string' },
    config: { type: 'string' },
    collection: { type: 'string' },
    hub: { type: 'string' }, port: { type: 'string' }, target: { type: 'string' },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  if (positionals[0] === 'hub') return hubMain(positionals.slice(1), values, cwd);
  if (positionals.length !== 1 || !['init', 'baseline', 'check', 'sync'].includes(positionals[0]!)) throw new Error(HELP);
  const command = positionals[0]!;
  const permitted: Record<string, string[]> = { init: ['upstream', 'ref', 'track', 'tags', 'config'], baseline: ['commit', 'config'], check: ['full', 'config', 'collection'], sync: ['full', 'model', 'pr', 'repo', 'base', 'config', 'collection'] };
  for (const key of Object.keys(values)) if (!permitted[command]!.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (values.collection !== undefined && values.config !== undefined) throw new Error('--collection and --config cannot be combined');
  const root = await repositoryRoot(cwd);
  if (command === 'init') {
    if (!values.upstream) throw new Error('init requires --upstream');
    if (values.track !== undefined && values.track !== 'releases' && values.track !== 'branch') throw new Error('--track must be releases or branch');
    await initialize(root, values.upstream, values.ref ?? 'main', values.config, {
      ...(values.track !== undefined ? { track: values.track } : {}),
      ...(values.tags !== undefined ? { tags: values.tags } : {}),
    });
    console.log(`Created ${values.config ?? 'oc-port-agent.json'}. Edit selections, acceptance criteria, preservation rules, and verification before setting a baseline.`);
  } else if (command === 'baseline') {
    if (!values.commit) throw new Error('baseline requires --commit; there is no implicit starting point');
    const state = await setBaseline(root, values.commit, values.config);
    console.log(`Baseline explicitly set to ${state.lastSyncedCommit}. This is an acknowledgment, not a parity check. Commit the policy and checkpoint; use sync --full for initial adoption.`);
  } else if (command === 'check') {
    const preview = (plan: Plan) => ({ mode: plan.mode, from: plan.from, to: plan.to, ...(plan.release ? { release: plan.release } : {}), commits: plan.commits, changedPaths: plan.changedPaths, selections: plan.selections.map(s => ({ id: s.id, description: s.description })), contextBytes: Buffer.byteLength(JSON.stringify(plan)) });
    if (values.collection !== undefined) {
      const { sources } = await planCollection(root, values.collection, values.full);
      console.log(JSON.stringify({ collection: values.collection, sources: sources.map(({ config, plan }) => ({ config: config.configurationPath, upstream: config.upstream, status: values.full || plan.from !== plan.to ? 'pending' : 'up-to-date', ...preview(plan) })) }, null, 2));
    } else {
      const { config, plan } = await planSync(root, values.full, values.config);
      console.log(JSON.stringify({ upstream: config.upstream, ...preview(plan) }, null, 2));
    }
  } else {
    if (values.pr && (!values.repo || !values.base)) throw new Error('--pr requires explicit --repo and --base');
    if (!values.pr && (values.repo || values.base)) throw new Error('--repo and --base require --pr');
    const result = await synchronize(root, {
      ...(values.full !== undefined ? { full: values.full } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.config !== undefined ? { config: values.config } : {}),
      ...(values.collection !== undefined ? { collection: values.collection } : {}),
      ...(values.pr ? { publish: { repository: values.repo!, base: values.base! } } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
