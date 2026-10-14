import { describe, expect, it } from 'vitest';
import { parsePolicy, policyHash } from '../src/policy.js';

function hostedPolicy(instructions?: unknown, schema?: unknown): Record<string, unknown> {
  const policy: Record<string, unknown> = {
    version: 1,
    upstream: { repository: 'https://github.com/upstream-org/project.git', ref: 'main' },
    selections: [{
      id: 'parser',
      description: 'Port parser behavior.',
      upstreamPaths: ['src/**'],
      excludeUpstreamPaths: ['src/vendor/**'],
      targetPaths: ['lib/**'],
      acceptance: ['Preserve target parser behavior.'],
      mappings: [{ upstream: 'src/parser.ts', target: ['lib/parser.ts'] }],
      ...(instructions !== undefined ? { instructions } : {}),
    }],
    preserve: ['Keep target-only helpers unchanged.'],
    verification: [{ command: 'npm', args: ['test', '--', '--runInBand'], timeoutSeconds: 10 }],
  };
  if (schema !== undefined) policy.$schema = schema;
  return policy;
}

describe('hosted structured porting instructions', () => {
  it('keeps legacy normalized shape and hash while ignoring validated editor metadata', async () => {
    const legacy = parsePolicy(hostedPolicy());
    expect(Object.hasOwn(legacy.selections[0]!, 'instructions')).toBe(false);
    expect(await policyHash(legacy)).toBe('3364b98d74078200f2898fecc42c2b0f368d5253316f9dd7d46b214e6d8ae676');

    const annotated = parsePolicy(hostedPolicy(undefined, './oc-port-policy.schema.json'));
    expect(Object.hasOwn(annotated, '$schema')).toBe(false);
    expect(JSON.stringify(annotated)).not.toContain('$schema');
    expect(await policyHash(annotated)).toBe(await policyHash(legacy));
    expect(() => parsePolicy(hostedPolicy(undefined, {}))).toThrow();
  });

  it('normalizes optional guidance arrays and clones nested instruction data', () => {
    const withoutLists = parsePolicy(hostedPolicy({ goal: 'Port parser behavior for 😀 inputs.' }));
    expect(withoutLists.selections[0]?.instructions).toEqual({
      goal: 'Port parser behavior for 😀 inputs.', adaptation: [], nonGoals: [],
    });

    const adaptation = ['Use the target parser API.'];
    const nonGoals = ['Do not add a dependency.'];
    const parsed = parsePolicy(hostedPolicy({ goal: 'Port parser behavior.', adaptation, nonGoals }));
    adaptation.push('Mutated input after parse.');
    nonGoals[0] = 'Mutated input after parse.';
    expect(parsed.selections[0]?.instructions).toEqual({
      goal: 'Port parser behavior.',
      adaptation: ['Use the target parser API.'],
      nonGoals: ['Do not add a dependency.'],
    });
  });

  it('rejects malformed, unknown, unsafe, oversized, and authority-changing fields', () => {
    const invalid: unknown[] = [
      {},
      { goal: '' },
      { goal: '   ' },
      { goal: 1 },
      { goal: 'Valid', additional: true },
      { goal: 'Valid', shell: 'allow' },
      { goal: 'Valid', adaptation: 'not-an-array' },
      { goal: 'Valid', adaptation: Array(1) },
      { goal: 'Valid', nonGoals: [''] },
      { goal: 'Valid', adaptation: Array.from({ length: 33 }, () => 'item') },
      { goal: 'Valid', nonGoals: Array.from({ length: 33 }, () => 'item') },
      { goal: 'x'.repeat(4097) },
      { goal: '\u0000control' },
      { goal: 'bad\u007f' },
      { goal: 'line\u2028break' },
      { goal: 'line\u0085break' },
      { goal: '\ud800' },
      { goal: '\udfff' },
    ];
    for (const instructions of invalid) expect(() => parsePolicy(hostedPolicy(instructions))).toThrow();
    expect(() => parsePolicy(hostedPolicy(null))).toThrow();
    expect(() => parsePolicy({ ...hostedPolicy(), permissions: { shell: true } })).toThrow(/unknown field/);
  });

  it('counts Unicode code points and binds every changed intent field into the hosted policy hash', async () => {
    const goal = '😀'.repeat(4096);
    expect(parsePolicy(hostedPolicy({ goal })).selections[0]?.instructions?.goal).toBe(goal);
    expect(() => parsePolicy(hostedPolicy({ goal: `${goal}😀` }))).toThrow(/4096 Unicode code points/);

    const base = parsePolicy(hostedPolicy({ goal: 'Implement the behavior.' }));
    const adapted = parsePolicy(hostedPolicy({ goal: 'Implement the behavior.', adaptation: ['Use target types.'] }));
    const excluded = parsePolicy(hostedPolicy({ goal: 'Implement the behavior.', nonGoals: ['No unrelated changes.'] }));
    expect(await policyHash(adapted)).not.toBe(await policyHash(base));
    expect(await policyHash(excluded)).not.toBe(await policyHash(base));
    expect(await policyHash(parsePolicy(hostedPolicy({ goal: 'Implement a different behavior.' })))).not.toBe(await policyHash(base));
  });
});
