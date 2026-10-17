#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { initialize, planSync, repositoryRoot, setBaseline } from './upstream.js';
import { synchronize } from './sync.js';
import { planCollection } from './collection.js';
import type { Plan } from './upstream.js';

const HELP = `oc-port-agent — adopt and track selected upstream functionality using OpenCode V2

Run inside the target Git repository:
  oc-port-agent init --upstream https://github.com/org/source.git [--ref main] [--config policies/source.json]
  oc-port-agent baseline --commit <upstream-SHA|HEAD>
  oc-port-agent check [--full]
  oc-port-agent sync [--full] [--model provider/model#variant] [--pr --repo owner/target --base main]
  check, baseline and sync accept --config <repository-relative-policy.json> for independently tracked upstreams.
  check and sync accept --collection <ports.json> to gather multiple policies into one target/proposal.

init writes a configurable tracking policy, not an implementation.
baseline explicitly acknowledges the starting point; commit the policy and state.
check fetches and previews WITHOUT calling OpenCode or advancing the checkpoint.
sync --full adopts existing selected functionality, including on an unchanged upstream.
sync creates a local proposal worktree. --pr also pushes and creates a draft PR.
No automatic merging, no blind cherry-picking, no implicit GitHub publication.
`;

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    upstream: { type: 'string' }, ref: { type: 'string' }, commit: { type: 'string' },
    full: { type: 'boolean' }, pr: { type: 'boolean' }, repo: { type: 'string' }, base: { type: 'string' },
    model: { type: 'string' },
    config: { type: 'string' },
    collection: { type: 'string' },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  if (positionals.length !== 1 || !['init', 'baseline', 'check', 'sync'].includes(positionals[0]!)) throw new Error(HELP);
  const command = positionals[0]!;
  const permitted: Record<string, string[]> = { init: ['upstream', 'ref', 'config'], baseline: ['commit', 'config'], check: ['full', 'config', 'collection'], sync: ['full', 'model', 'pr', 'repo', 'base', 'config', 'collection'] };
  for (const key of Object.keys(values)) if (!permitted[command]!.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (values.collection !== undefined && values.config !== undefined) throw new Error('--collection and --config cannot be combined');
  const root = await repositoryRoot(cwd);
  if (command === 'init') {
    if (!values.upstream) throw new Error('init requires --upstream');
    await initialize(root, values.upstream, values.ref ?? 'main', values.config);
    console.log(`Created ${values.config ?? 'oc-port-agent.json'}. Edit selections, acceptance criteria, preservation rules, and verification before setting a baseline.`);
  } else if (command === 'baseline') {
    if (!values.commit) throw new Error('baseline requires --commit; there is no implicit starting point');
    const state = await setBaseline(root, values.commit, values.config);
    console.log(`Baseline explicitly set to ${state.lastSyncedCommit}. This is an acknowledgment, not a parity check. Commit the policy and checkpoint; use sync --full for initial adoption.`);
  } else if (command === 'check') {
    const preview = (plan: Plan) => ({ mode: plan.mode, from: plan.from, to: plan.to, commits: plan.commits, changedPaths: plan.changedPaths, selections: plan.selections.map(s => ({ id: s.id, description: s.description })), contextBytes: Buffer.byteLength(JSON.stringify(plan)) });
    if (values.collection !== undefined) {
      const { sources } = await planCollection(root, values.collection, values.full);
      console.log(JSON.stringify({ collection: values.collection, sources: sources.map(({ config, plan }) => ({ config: config.configurationPath, upstream: config.upstream, status: values.full || plan.from !== plan.to ? 'pending' : 'up-to-date', ...preview(plan) })) }, null, 2));
    } else {
      console.log(JSON.stringify(preview((await planSync(root, values.full, values.config)).plan), null, 2));
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
