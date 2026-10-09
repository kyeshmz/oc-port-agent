import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONFIG = 'oc-port-agent.json';
export const STATE = '.oc-port/state.json';
export const INTERNAL = ['.git', '.git/**', '.oc-port/**', CONFIG, '.opencode/**', 'opencode.json', 'opencode.jsonc'];
export const DEFAULT_PROTECTED = ['.github/workflows/**', 'AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md'];

export interface Selection {
  id: string;
  description: string;
  upstreamPaths: string[];
  excludeUpstreamPaths: string[];
  targetPaths: string[];
  acceptance: string[];
  mappings: { upstream: string; target: string[] }[];
}
export interface Verification {
  command: string;
  args: string[];
  timeoutSeconds: number;
}
export interface Config {
  version: 1;
  upstream: { repository: string; ref: string };
  selections: Selection[];
  preserve: string[];
  protectedPaths: string[];
  verification: Verification[];
  opencode: { executable: string; model?: string; timeoutSeconds: number; maxAttempts: number; steps: number };
  limits: { maxCommits: number; maxContextBytes: number };
}
export interface State {
  version: 1;
  upstream: Config['upstream'];
  policyHash: string;
  lastSyncedCommit: string;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${where} field: ${key}`);
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error(`${where} must be a nonempty single-line string`);
  return value;
}
function strings(value: unknown, where: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${where} must be an array with at least ${minimum} items`);
  return value.map((item, i) => string(item, `${where}[${i}]`));
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number, where: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${where} must be between ${minimum} and ${maximum}`);
  return Number(value);
}
export function safePath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f]/.test(path)
    && path.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}
function patterns(value: unknown, where: string, minimum = 0): string[] {
  const result = strings(value, where, minimum);
  for (const pattern of result) {
    if (!safePath(pattern) || /[\[\]{}]/.test(pattern)) throw new Error(`${where}: use repository-relative paths and only *, **, or ? globs: ${pattern}`);
  }
  return result;
}

// Deliberately small glob grammar, shared by context selection and host edit gates.
export function matches(path: string, pattern: string): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(path);
}
export const matchesAny = (path: string, patterns: string[]): boolean => patterns.some(pattern => matches(path, pattern));
export const selected = (path: string, selection: Selection): boolean => matchesAny(path, selection.upstreamPaths) && !matchesAny(path, selection.excludeUpstreamPaths);

export function parseConfig(input: unknown): Config {
  const root = object(input, 'config');
  keys(root, ['$schema', 'version', 'upstream', 'selections', 'preserve', 'protectedPaths', 'verification', 'opencode', 'limits'], 'config');
  if (root.$schema !== undefined) string(root.$schema, '$schema');
  if (root.version !== 1) throw new Error('config.version must be 1');
  const upstream = object(root.upstream, 'upstream');
  keys(upstream, ['repository', 'ref'], 'upstream');
  const repository = string(upstream.repository, 'upstream.repository');
  if (!repository.startsWith('https://') && !repository.startsWith('/')) throw new Error('upstream.repository must be an HTTPS URL or absolute local repository path');
  if (repository.startsWith('https://')) {
    const url = new URL(repository);
    if (url.username || url.password || url.search || url.hash) throw new Error('Do not put credentials, queries, or fragments in the upstream URL');
  }
  const ref = string(upstream.ref, 'upstream.ref');
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || /[ ~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) throw new Error('upstream.ref must be a branch name, not a revision expression');
  if (!Array.isArray(root.selections) || !root.selections.length) throw new Error('Configure at least one selection');
  const ids = new Set<string>();
  const selections = root.selections.map((raw, i): Selection => {
    const s = object(raw, `selections[${i}]`);
    keys(s, ['id', 'description', 'upstreamPaths', 'excludeUpstreamPaths', 'targetPaths', 'acceptance', 'mappings'], 'selection');
    const id = string(s.id, 'selection.id');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) throw new Error(`Selection IDs must be unique lowercase slugs: ${id}`);
    ids.add(id);
    if (s.mappings !== undefined && !Array.isArray(s.mappings)) throw new Error('selection.mappings must be an array');
    const mappings = ((s.mappings ?? []) as unknown[]).map(raw => {
      const m = object(raw, 'mapping');
      keys(m, ['upstream', 'target'], 'mapping');
      return { upstream: patterns([m.upstream], 'mapping.upstream', 1)[0]!, target: patterns(m.target, 'mapping.target', 1) };
    });
    return {
      id, description: string(s.description, 'selection.description'),
      upstreamPaths: patterns(s.upstreamPaths, 'selection.upstreamPaths', 1),
      excludeUpstreamPaths: patterns(s.excludeUpstreamPaths ?? [], 'selection.excludeUpstreamPaths'),
      targetPaths: patterns(s.targetPaths, 'selection.targetPaths', 1),
      acceptance: strings(s.acceptance, 'selection.acceptance', 1), mappings,
    };
  });
  if (!Array.isArray(root.verification) || !root.verification.length) throw new Error('Configure at least one trusted verification command; a build alone does not establish parity');
  const verification = root.verification.map((raw): Verification => {
    const v = object(raw, 'verification');
    keys(v, ['command', 'args', 'timeoutSeconds'], 'verification');
    const command = string(v.command, 'verification.command');
    if (command.startsWith('-')) throw new Error('Invalid verification executable');
    if (!Array.isArray(v.args) || v.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('verification.args must be an array of strings');
    return { command, args: v.args as string[], timeoutSeconds: integer(v.timeoutSeconds, 300, 1, 3600, 'verification.timeoutSeconds') };
  });
  const oc = object(root.opencode ?? {}, 'opencode');
  keys(oc, ['executable', 'model', 'timeoutSeconds', 'maxAttempts', 'steps'], 'opencode');
  const limits = object(root.limits ?? {}, 'limits');
  keys(limits, ['maxCommits', 'maxContextBytes'], 'limits');
  return {
    version: 1, upstream: { repository, ref }, selections,
    preserve: strings(root.preserve ?? [], 'preserve'),
    protectedPaths: patterns(root.protectedPaths ?? DEFAULT_PROTECTED, 'protectedPaths'), verification,
    opencode: {
      executable: string(oc.executable ?? 'opencode', 'opencode.executable'),
      ...(oc.model !== undefined ? { model: string(oc.model, 'opencode.model') } : {}),
      timeoutSeconds: integer(oc.timeoutSeconds, 1200, 1, 7200, 'opencode.timeoutSeconds'),
      maxAttempts: integer(oc.maxAttempts, 2, 1, 5, 'opencode.maxAttempts'),
      steps: integer(oc.steps, 100, 1, 500, 'opencode.steps'),
    },
    limits: {
      maxCommits: integer(limits.maxCommits, 100, 1, 10000, 'limits.maxCommits'),
      maxContextBytes: integer(limits.maxContextBytes, 1_000_000, 1000, 50_000_000, 'limits.maxContextBytes'),
    },
  };
}

export async function loadConfig(root: string): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(join(root, CONFIG), 'utf8')));
}
export function policyHash(config: Config): string {
  return createHash('sha256').update(JSON.stringify({ upstream: config.upstream, selections: config.selections, preserve: config.preserve, protectedPaths: config.protectedPaths, verification: config.verification })).digest('hex');
}
export function parseState(raw: unknown, config: Config): State {
  const s = object(raw, 'state');
  keys(s, ['version', 'upstream', 'policyHash', 'lastSyncedCommit'], 'state');
  if (s.version !== 1 || !/^[a-f0-9]{40,64}$/.test(String(s.lastSyncedCommit))) throw new Error('Invalid sync checkpoint');
  const upstream = object(s.upstream, 'state.upstream');
  if (upstream.repository !== config.upstream.repository || upstream.ref !== config.upstream.ref || s.policyHash !== policyHash(config)) throw new Error('Tracking policy changed. Review it and explicitly run baseline --commit <SHA>, then sync --full to adopt newly selected functionality.');
  return s as unknown as State;
}
