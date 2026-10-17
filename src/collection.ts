import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { safePath } from './config.js';
import { planSync } from './upstream.js';

export interface Collection {
  version: 1;
  policies: string[];
}

export function parseCollection(value: unknown): Collection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Collection must be an object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!['$schema', 'version', 'policies'].includes(key)) throw new Error(`Unknown collection field: ${key}`);
  if (raw.$schema !== undefined && (typeof raw.$schema !== 'string' || !raw.$schema.trim())) throw new Error('Collection $schema must be a nonempty string');
  if (raw.version !== 1) throw new Error('Collection version must be 1');
  if (!Array.isArray(raw.policies) || !raw.policies.length || raw.policies.length > 100) throw new Error('Collection policies must contain 1–100 policy files');
  const policies = Array.from(raw.policies, file => {
    if (typeof file !== 'string' || !safePath(file) || /[?*]/.test(file)) throw new Error('Collection policies must be exact repository-relative files');
    return file;
  });
  if (new Set(policies).size !== policies.length) throw new Error('Collection policies must be unique');
  return { version: 1, policies };
}

export async function planCollection(root: string, file: string, full = false): Promise<{ collection: Collection; sources: Awaited<ReturnType<typeof planSync>>[] }> {
  const directory = await realpath(root);
  const exactFile = async (path: string): Promise<void> => {
    if (!safePath(path) || /[?*]/.test(path)) throw new Error('--collection and its policies must be exact repository-relative files');
    if (relative(directory, await realpath(join(directory, path))) !== path) throw new Error(`Collection files cannot escape the repository or use symlink aliases: ${path}`);
  };
  await exactFile(file);
  const collection = parseCollection(JSON.parse(await readFile(join(root, file), 'utf8')));
  for (const policy of collection.policies) {
    if (policy === file) throw new Error('A collection cannot include itself as a policy');
    await exactFile(policy);
  }
  const sources: Awaited<ReturnType<typeof planSync>>[] = [];
  // Preflight every policy before creating a proposal or invoking a model.
  for (const policy of collection.policies) {
    try {
      const source = await planSync(root, full, policy);
      source.config.protectedConfigPaths = [file, ...collection.policies];
      sources.push(source);
    } catch (error) {
      throw new Error(`Policy ${policy}: ${(error as Error).message}`);
    }
  }
  return { collection, sources };
}
