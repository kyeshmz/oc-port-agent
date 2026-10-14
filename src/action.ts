import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './process.js';

export interface ActionInvocation { args: string[]; env: NodeJS.ProcessEnv; apiKey?: string }

export function actionInvocation(environment: NodeJS.ProcessEnv): ActionInvocation {
  const mode = environment.OC_PORT_MODE ?? 'sync';
  const publication = environment.OC_PORT_PUBLISH ?? 'false';
  if (!['check', 'sync', 'adopt'].includes(mode)) throw new Error('mode must be check, sync, or adopt');
  if (!['true', 'false'].includes(publication)) throw new Error('publish must be true or false');
  if (mode === 'check' && publication === 'true') throw new Error('check cannot publish');
  const args = mode === 'adopt' ? ['sync', '--full'] : [mode];
  if (environment.OC_PORT_CONFIG) args.push('--config', environment.OC_PORT_CONFIG);
  const env = { ...environment };
  // Only the selected provider receives this credential, through the environment.
  delete env.OC_PORT_API_KEY;
  let apiKey: string | undefined;
  if (mode !== 'check') {
    const variable = environment.OC_PORT_API_KEY_ENV || 'OPENCODE_API_KEY';
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(variable)) throw new Error('api-key-env must be a provider credential variable ending in _API_KEY (for example OPENAI_API_KEY)');
    apiKey = environment.OC_PORT_API_KEY || environment[variable];
    if (!apiKey?.trim() || /[\r\n\0]/.test(apiKey)) throw new Error(`Supply api-key from GitHub Secrets or set ${variable}; no interactive login is used`);
    env[variable] = apiKey;
    const model = environment.OC_PORT_MODEL;
    if (model) {
      if (!/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error('model must be provider/model, optionally followed by #variant');
      args.push('--model', model);
    }
  }
  if (publication === 'true') {
    if (!environment.OC_PORT_REPOSITORY || !environment.OC_PORT_BASE) throw new Error('Publishing requires repository and base inputs');
    args.push('--pr', '--repo', environment.OC_PORT_REPOSITORY, '--base', environment.OC_PORT_BASE);
  }
  return { args, env, ...(apiKey !== undefined ? { apiKey } : {}) };
}

export async function runAction(environment = process.env): Promise<void> {
  const invocation = actionInvocation(environment);
  if (invocation.apiKey && environment.GITHUB_ACTIONS === 'true') {
    // Escape command metacharacters; never print this outside the Actions masking protocol.
    console.log(`::add-mask::${invocation.apiKey.replaceAll('%', '%25')}`);
  }
  if (environment.OC_PORT_MODE !== 'check') {
    // Saved OAuth/accounts otherwise take precedence over environment credentials in V2.
    // An isolated database makes the supplied CI key authoritative, even on self-hosted runners.
    const directory = mkdtempSync(join(environment.RUNNER_TEMP || tmpdir(), 'oc-port-ci-'));
    invocation.env.OPENCODE_DB = join(directory, 'opencode.db');
  }
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const result = await run(process.execPath, [cli, ...invocation.args], process.cwd(), 14400, invocation.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`oc-port-agent action failed (exit ${result.code})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAction().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
