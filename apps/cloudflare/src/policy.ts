export interface SelectionPolicy {
  id: string;
  description: string;
  upstreamPaths: readonly string[];
  excludeUpstreamPaths: readonly string[];
  targetPaths: readonly string[];
  acceptance: readonly string[];
  mappings: readonly { upstream: string; target: readonly string[] }[];
  instructions?: SelectionInstructions;
}

export interface SelectionInstructions {
  goal: string;
  adaptation: readonly string[];
  nonGoals: readonly string[];
}

export interface VerificationCommand {
  command: string;
  args: readonly string[];
  timeoutSeconds: number;
}

export interface PolicyLimits {
  maxCommits: number;
  maxChangedPaths: number;
  maxFiles: number;
  maxContextBytes: number;
  maxFileBytes: number;
  maxResponseBytes: number;
  maxVerificationOutputBytes: number;
  maxJobSeconds: number;
  maxAttempts: number;
  maxSteps: number;
}

export interface CloudflarePolicy {
  version: 1;
  upstream: { repository: string; ref: string };
  selections: readonly SelectionPolicy[];
  preserve: readonly string[];
  protectedPaths: readonly string[];
  verification: readonly VerificationCommand[];
  limits: PolicyLimits;
}

export const INTERNAL_PATHS = [
  '.git', '.git/**', '**/.git/**', '.oc-port/**', '.opencode/**', 'opencode.json', 'opencode.jsonc',
] as const;

export const DEFAULT_PROTECTED_PATHS = [
  '.github/workflows/**', 'AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md',
] as const;

export const SENSITIVE_PATHS = [
  '.env', '.env.*', '**/.env', '**/.env.*',
  '.npmrc', '**/.npmrc',
  '.ssh/**', '**/.ssh/**',
  '.aws/**', '**/.aws/**',
  '.azure/**', '**/.azure/**',
  '.config/gcloud/**', '**/.config/gcloud/**',
  '.config/gh/hosts.yml', '**/.config/gh/hosts.yml',
  '.docker/config.json', '**/.docker/config.json',
  '.kube/config', '**/.kube/config',
  '.netrc', '**/.netrc',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/*_rsa', '**/*_ed25519', '**/*_ecdsa',
  '**/credentials', '**/credentials.*', '**/credentials.json', '**/secrets.*', '**/secrets.json',
] as const;

/** Maximum deterministic DP work shared by all glob checks in one policy operation/job. */
export const MAX_GLOB_MATCH_WORK = 20_000_000;

export interface GlobWorkBudget {
  readonly limit: number;
  used: number;
}

export function createGlobWorkBudget(limit = MAX_GLOB_MATCH_WORK): GlobWorkBudget {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Glob work limit must be a positive safe integer');
  return { limit, used: 0 };
}

export const DEFAULT_LIMITS: Readonly<PolicyLimits> = Object.freeze({
  maxCommits: 100,
  maxChangedPaths: 5_000,
  maxFiles: 200,
  maxContextBytes: 250_000,
  maxFileBytes: 250_000,
  maxResponseBytes: 1_000_000,
  maxVerificationOutputBytes: 65_536,
  maxJobSeconds: 1_800,
  maxAttempts: 2,
  maxSteps: 50,
});

const LIMIT_RANGES: Readonly<Record<keyof PolicyLimits, readonly [number, number]>> = {
  maxCommits: [1, 10_000],
  maxChangedPaths: [1, 20_000],
  maxFiles: [1, 2_000],
  maxContextBytes: [1_000, 50_000_000],
  maxFileBytes: [1_000, 10_000_000],
  maxResponseBytes: [10_000, 20_000_000],
  maxVerificationOutputBytes: [1_024, 1_000_000],
  maxJobSeconds: [1, 7_200],
  maxAttempts: [1, 5],
  maxSteps: [1, 500],
};

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

function fail(where: string, detail: string): never {
  throw new PolicyValidationError(`${where} ${detail}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(where, 'must be an object');
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `has unknown field ${key}`);
}

function text(value: unknown, where: string, maxLength = 10_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    return fail(where, `must be a nonempty single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function textList(value: unknown, where: string, minimum = 0, maximum = 256, maxLength = 10_000): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return fail(where, `must be an array with ${minimum} to ${maximum} items`);
  }
  return value.map((item: unknown, index: number) => text(item, `${where}[${index}]`, maxLength));
}

function instructionText(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(value)) {
    return fail(where, 'must be nonempty, single-line Unicode text without control characters');
  }
  let codePoints = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail(where, 'must contain valid Unicode text');
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return fail(where, 'must contain valid Unicode text');
    }
    if (++codePoints > 4_096) return fail(where, 'must contain at most 4096 Unicode code points');
  }
  return value;
}

function instructionList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length > 32) return fail(where, 'must be an array of at most 32 items');
  return Array.from(value, (item: unknown, index: number) => instructionText(item, `${where}[${index}]`));
}

function parseInstructions(value: unknown, where: string): SelectionInstructions {
  const raw = object(value, where);
  assertKeys(raw, ['goal', 'adaptation', 'nonGoals'], where);
  if (!Object.hasOwn(raw, 'goal')) fail(`${where}.goal`, 'is required');
  return {
    goal: instructionText(raw.goal, `${where}.goal`),
    adaptation: raw.adaptation === undefined ? [] : instructionList(raw.adaptation, `${where}.adaptation`),
    nonGoals: raw.nonGoals === undefined ? [] : instructionList(raw.nonGoals, `${where}.nonGoals`),
  };
}

function strictInteger(value: unknown, where: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail(where, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 4_096
    && !hasUnpairedSurrogate(path)
    && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function pathPatterns(value: unknown, where: string, minimum = 0): string[] {
  const patterns = textList(value, where, minimum, 256, 1_024);
  for (const pattern of patterns) {
    if (!safePath(pattern) || /[\[\]{}]/.test(pattern)) {
      fail(where, `must use repository-relative paths and only *, **, or ? globs: ${pattern}`);
    }
  }
  return patterns;
}

function githubRepositoryUrl(value: unknown): string {
  const repository = text(value, 'upstream.repository', 2_048);
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return fail('upstream.repository', 'must be an HTTPS GitHub repository URL');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port
    || url.username || url.password || url.search || url.hash) {
    return fail('upstream.repository', 'must be an HTTPS GitHub URL without credentials, port, query, or fragment');
  }
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(segments[0]!) || !/^[A-Za-z0-9_.-]+$/.test(segments[1]!)) {
    return fail('upstream.repository', 'must identify exactly one GitHub owner and repository');
  }
  return `https://github.com/${segments[0]}/${segments[1]}.git`;
}

function branchName(value: unknown): string {
  const ref = text(value, 'upstream.ref', 255);
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')
    || ref.includes('..') || ref.includes('@{') || ref.includes('//') || /[ ~^:?*\[\\\x00-\x20\x7f]/.test(ref)) {
    return fail('upstream.ref', 'must be a branch name, not a revision expression');
  }
  return ref;
}

function parseSelection(value: unknown, index: number): SelectionPolicy {
  const where = `selections[${index}]`;
  const raw = object(value, where);
  assertKeys(raw, ['id', 'description', 'upstreamPaths', 'excludeUpstreamPaths', 'targetPaths', 'acceptance', 'mappings', 'instructions'], where);
  const id = text(raw.id, `${where}.id`, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`${where}.id`, 'must be a lowercase slug');
  const mappingsRaw = raw.mappings ?? [];
  if (!Array.isArray(mappingsRaw) || mappingsRaw.length > 256) fail(`${where}.mappings`, 'must be an array of at most 256 items');
  const mappings = mappingsRaw.map((entry: unknown, mappingIndex: number) => {
    const mappingWhere = `${where}.mappings[${mappingIndex}]`;
    const mapping = object(entry, mappingWhere);
    assertKeys(mapping, ['upstream', 'target'], mappingWhere);
    return {
      upstream: pathPatterns([mapping.upstream], `${mappingWhere}.upstream`, 1)[0]!,
      target: pathPatterns(mapping.target, `${mappingWhere}.target`, 1),
    };
  });
  return {
    id,
    description: text(raw.description, `${where}.description`, 2_000),
    upstreamPaths: pathPatterns(raw.upstreamPaths, `${where}.upstreamPaths`, 1),
    excludeUpstreamPaths: pathPatterns(raw.excludeUpstreamPaths ?? [], `${where}.excludeUpstreamPaths`),
    targetPaths: pathPatterns(raw.targetPaths, `${where}.targetPaths`, 1),
    acceptance: textList(raw.acceptance, `${where}.acceptance`, 1, 100, 5_000),
    mappings,
    ...(raw.instructions !== undefined ? { instructions: parseInstructions(raw.instructions, `${where}.instructions`) } : {}),
  };
}

function parseLimits(value: unknown): PolicyLimits {
  if (value === undefined) return { ...DEFAULT_LIMITS };
  const raw = object(value, 'limits');
  const names = Object.keys(DEFAULT_LIMITS) as (keyof PolicyLimits)[];
  assertKeys(raw, names, 'limits');
  const parsed = {} as PolicyLimits;
  for (const name of names) {
    const [minimum, maximum] = LIMIT_RANGES[name];
    const fallback = DEFAULT_LIMITS[name];
    parsed[name] = raw[name] === undefined ? fallback : strictInteger(raw[name], `limits.${name}`, minimum, maximum);
  }
  if (parsed.maxFileBytes > parsed.maxContextBytes) fail('limits.maxFileBytes', 'must not exceed maxContextBytes');
  if (parsed.maxResponseBytes < parsed.maxFileBytes) fail('limits.maxResponseBytes', 'must be at least maxFileBytes');
  return parsed;
}

export function parsePolicy(value: unknown): CloudflarePolicy {
  const raw = object(value, 'policy');
  assertKeys(raw, ['$schema', 'version', 'upstream', 'selections', 'preserve', 'protectedPaths', 'verification', 'limits'], 'policy');
  if (raw.$schema !== undefined) text(raw.$schema, 'policy.$schema');
  if (raw.version !== 1) fail('policy.version', 'must be 1');

  const upstreamRaw = object(raw.upstream, 'upstream');
  assertKeys(upstreamRaw, ['repository', 'ref'], 'upstream');
  if (!Array.isArray(raw.selections) || raw.selections.length < 1 || raw.selections.length > 100) {
    fail('selections', 'must contain between 1 and 100 rules');
  }
  const selections = raw.selections.map(parseSelection);
  const ids = new Set<string>();
  for (const selection of selections) {
    if (ids.has(selection.id)) fail('selections', `contains duplicate id ${selection.id}`);
    ids.add(selection.id);
  }

  if (!Array.isArray(raw.verification) || raw.verification.length < 1 || raw.verification.length > 10) {
    fail('verification', 'must contain between 1 and 10 argv commands');
  }
  const verification = raw.verification.map((entry: unknown, index: number): VerificationCommand => {
    const where = `verification[${index}]`;
    const command = object(entry, where);
    assertKeys(command, ['command', 'args', 'timeoutSeconds'], where);
    const executable = text(command.command, `${where}.command`, 1_024);
    if (executable.startsWith('-')) fail(`${where}.command`, 'must not start with a dash');
    if (!Array.isArray(command.args) || command.args.length > 256) fail(`${where}.args`, 'must be an array of at most 256 strings');
    const args = command.args.map((arg: unknown, argIndex: number) => text(arg, `${where}.args[${argIndex}]`, 4_096));
    return {
      command: executable,
      args,
      timeoutSeconds: command.timeoutSeconds === undefined
        ? 300
        : strictInteger(command.timeoutSeconds, `${where}.timeoutSeconds`, 1, 3_600),
    };
  });

  return {
    version: 1,
    upstream: { repository: githubRepositoryUrl(upstreamRaw.repository), ref: branchName(upstreamRaw.ref) },
    selections,
    preserve: textList(raw.preserve ?? [], 'preserve', 0, 256, 10_000),
    protectedPaths: raw.protectedPaths === undefined
      ? [...DEFAULT_PROTECTED_PATHS]
      : pathPatterns(raw.protectedPaths, 'protectedPaths'),
    verification,
    limits: parseLimits(raw.limits),
  };
}

type GlobToken =
  | { kind: 'literal'; value: string }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'globstar-directories' };

const MAX_CACHED_GLOB_PATTERNS = 4_096;
const MAX_CACHED_GLOB_PATTERN_CHARS = 256_000;
const compiledGlobs = new Map<string, readonly GlobToken[]>();
let compiledGlobChars = 0;

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        index++;
        tokens.push({ kind: 'globstar-directories' });
      } else {
        tokens.push({ kind: 'globstar' });
      }
    } else if (character === '*') {
      tokens.push({ kind: 'star' });
    } else if (character === '?') {
      tokens.push({ kind: 'one' });
    } else {
      tokens.push({ kind: 'literal', value: character });
    }
  }
  return tokens;
}

function compiledGlob(pattern: string): readonly GlobToken[] {
  const cached = compiledGlobs.get(pattern);
  if (cached) {
    // Refresh insertion order to make this a bounded LRU cache.
    compiledGlobs.delete(pattern);
    compiledGlobs.set(pattern, cached);
    return cached;
  }

  const tokens = tokenizeGlob(pattern);
  if (pattern.length <= MAX_CACHED_GLOB_PATTERN_CHARS) {
    while (compiledGlobs.size >= MAX_CACHED_GLOB_PATTERNS
      || compiledGlobChars + pattern.length > MAX_CACHED_GLOB_PATTERN_CHARS) {
      const oldest = compiledGlobs.keys().next();
      if (oldest.done) break;
      compiledGlobChars -= oldest.value.length;
      compiledGlobs.delete(oldest.value);
    }
    compiledGlobs.set(pattern, tokens);
    compiledGlobChars += pattern.length;
  }
  return tokens;
}

function chargeGlobWork(budget: GlobWorkBudget, work: number): void {
  if (work > budget.limit - budget.used) {
    throw new PolicyValidationError('Glob matching work exceeds the deterministic safety limit');
  }
  budget.used += work;
}

/**
 * Deliberately small glob grammar, identical to the portable CLI policy semantics.
 * Matching is an anchored dynamic program: O(pattern length × path length), with
 * a shared deterministic work budget instead of backtracking regular expressions.
 */
export function matches(path: string, pattern: string, budget = createGlobWorkBudget()): boolean {
  if (!safePath(path) || !safePath(pattern) || /[\[\]{}]/.test(pattern)) return false;

  const tokens = compiledGlob(pattern);
  const width = path.length + 1;
  chargeGlobWork(budget, (pattern.length + tokens.length) * width);

  let previous = new Uint8Array(width);
  previous[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(width);
    if (token.kind === 'literal' || token.kind === 'one') {
      for (let offset = 1; offset < width; offset++) {
        const character = path[offset - 1]!;
        if (previous[offset - 1] === 1
          && (token.kind === 'literal' ? character === token.value : character !== '/')) {
          next[offset] = 1;
        }
      }
    } else if (token.kind === 'star') {
      next[0] = previous[0]!;
      for (let offset = 1; offset < width; offset++) {
        next[offset] = previous[offset] === 1
          || (path[offset - 1] !== '/' && next[offset - 1] === 1) ? 1 : 0;
      }
    } else if (token.kind === 'globstar') {
      next[0] = previous[0]!;
      for (let offset = 1; offset < width; offset++) {
        next[offset] = previous[offset] === 1 || next[offset - 1] === 1 ? 1 : 0;
      }
    } else {
      next[0] = previous[0]!;
      let canConsumeThroughSlash = false;
      for (let offset = 1; offset < width; offset++) {
        canConsumeThroughSlash ||= previous[offset - 1] === 1;
        next[offset] = previous[offset] === 1
          || (path[offset - 1] === '/' && canConsumeThroughSlash) ? 1 : 0;
      }
    }
    previous = next;
  }
  return previous[path.length] === 1;
}

export function matchesAny(path: string, patterns: readonly string[], budget = createGlobWorkBudget()): boolean {
  for (const pattern of patterns) if (matches(path, pattern, budget)) return true;
  return false;
}

export function isProtectedOrSensitive(path: string, policy: CloudflarePolicy, budget = createGlobWorkBudget()): boolean {
  return matchesAny(path, excludedPathPatterns(policy), budget);
}

/** Paths excluded before GitHub content reads and before they can reach an agent or runner. */
export function excludedPathPatterns(policy: CloudflarePolicy): string[] {
  return [
    ...INTERNAL_PATHS,
    ...DEFAULT_PROTECTED_PATHS,
    ...SENSITIVE_PATHS,
    ...policy.protectedPaths,
  ];
}

export interface PathFilterResult {
  selectedPaths: string[];
  ignoredPaths: string[];
  selectionPaths: Record<string, string[]>;
}

/** Cheap deny/protection checks happen before selection globs and before any snapshot reads. */
export function filterChangedPaths(
  policy: CloudflarePolicy,
  changedPaths: readonly string[],
  budget = createGlobWorkBudget(),
): PathFilterResult {
  if (changedPaths.length > policy.limits.maxChangedPaths) throw new PolicyValidationError('Changed path count exceeds policy limit');
  const selectedPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const selectionPaths: Record<string, string[]> = Object.fromEntries(policy.selections.map(selection => [selection.id, []]));
  const seen = new Set<string>();
  for (const path of changedPaths) {
    if (!safePath(path)) throw new PolicyValidationError('Unsafe repository path');
    if (seen.has(path)) continue;
    seen.add(path);
    if (isProtectedOrSensitive(path, policy, budget)) {
      ignoredPaths.push(path);
      continue;
    }
    let selected = false;
    for (const selection of policy.selections) {
      if (matchesAny(path, selection.upstreamPaths, budget) && !matchesAny(path, selection.excludeUpstreamPaths, budget)) {
        selectionPaths[selection.id]!.push(path);
        selected = true;
      }
    }
    (selected ? selectedPaths : ignoredPaths).push(path);
  }
  return { selectedPaths, ignoredPaths, selectionPaths };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** SHA-256 over validated policy, including safety limits and verification argv. */
export async function policyHash(policy: CloudflarePolicy): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(policy)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
