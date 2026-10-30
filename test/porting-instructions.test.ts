import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseConfig } from '../src/config.js';
import { configInput } from './helpers.js';

function withInstructions(instructions: unknown): Record<string, unknown> {
  const input = configInput('/upstream');
  (input.selections as Record<string, unknown>[])[0]!.instructions = instructions;
  return input;
}

test('CLI structured instructions default optional arrays and clone nested policy data', () => {
  const goal = 'Port retry behavior for 😀 clients.';
  const parsed = parseConfig(withInstructions({ goal }));
  assert.deepEqual(parsed.selections[0]!.instructions, { goal, adaptation: [], nonGoals: [] });

  const adaptation = ['Use the target cancellation API.'];
  const nonGoals = ['Do not add a dependency.'];
  const raw = withInstructions({ goal, adaptation, nonGoals });
  const cloned = parseConfig(raw);
  adaptation.push('Mutated after parse.');
  nonGoals[0] = 'Mutated after parse.';
  assert.deepEqual(cloned.selections[0]!.instructions, {
    goal,
    adaptation: ['Use the target cancellation API.'],
    nonGoals: ['Do not add a dependency.'],
  });
  cloned.selections[0]!.instructions!.adaptation.push('Mutated normalized copy.');
  assert.deepEqual(adaptation, ['Use the target cancellation API.', 'Mutated after parse.']);
});

test('CLI rejects malformed, unknown, unsafe, and oversized instruction values', () => {
  const invalid: unknown[] = [
    {},
    { goal: '' },
    { goal: '   ' },
    { goal: 42 },
    { goal: 'Valid goal', surprise: 'unknown' },
    { goal: 'Valid goal', shell: 'allow' },
    { goal: 'Valid goal', adaptation: 'not an array' },
    { goal: 'Valid goal', nonGoals: null },
    { goal: 'Valid goal', adaptation: [''] },
    { goal: 'Valid goal', adaptation: Array(1) },
    { goal: 'Valid goal', nonGoals: ['\u0001control'] },
    { goal: 'Valid goal\u007f' },
    { goal: 'Line one\u2028Line two' },
    { goal: '\ud800' },
    { goal: '\udfff' },
    { goal: 'x'.repeat(4097) },
    { goal: 'Valid goal', adaptation: Array.from({ length: 33 }, () => 'item') },
    { goal: 'Valid goal', nonGoals: Array.from({ length: 33 }, () => 'item') },
  ];
  for (const value of invalid) {
    assert.throws(() => parseConfig(withInstructions(value)), error => error instanceof Error, JSON.stringify(value));
  }
  assert.throws(() => parseConfig(withInstructions(null)), /object/);
});

test('instruction limits count Unicode code points and accept astral text', () => {
  const exactlyAtLimit = '😀'.repeat(4096);
  assert.equal(parseConfig(withInstructions({ goal: exactlyAtLimit })).selections[0]!.instructions!.goal, exactlyAtLimit);
  assert.throws(() => parseConfig(withInstructions({ goal: `${exactlyAtLimit}😀` })), /4096 Unicode code points/);
});

test('real draft 2020-12 schemas resolve local shared refs and accept both examples', async () => {
  const schemaDirectory = join(process.cwd(), 'schema');
  const exampleDirectory = join(process.cwd(), 'examples');
  const sharedUri = pathToFileURL(join(schemaDirectory, 'porting-instructions.schema.json')).href;
  const cliUri = pathToFileURL(join(schemaDirectory, 'oc-port-agent.schema.json')).href;
  const hostedUri = pathToFileURL(join(schemaDirectory, 'oc-port-policy.schema.json')).href;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(JSON.parse(await readFile(join(schemaDirectory, 'porting-instructions.schema.json'), 'utf8')), sharedUri);
  ajv.addSchema(JSON.parse(await readFile(join(schemaDirectory, 'oc-port-agent.schema.json'), 'utf8')), cliUri);
  ajv.addSchema(JSON.parse(await readFile(join(schemaDirectory, 'oc-port-policy.schema.json'), 'utf8')), hostedUri);

  const validateCli = ajv.getSchema(cliUri);
  const validateHosted = ajv.getSchema(hostedUri);
  const validateInstructions = ajv.getSchema(sharedUri);
  assert.ok(validateCli, 'CLI schema should compile with its sibling $ref');
  assert.ok(validateHosted, 'hosted schema should compile with its sibling $ref');
  assert.ok(validateInstructions, 'shared instruction schema should compile');
  assert.equal(validateCli({ ...configInput(), allowNulTextPaths: ['src/spectrum.ts'] }), true, JSON.stringify(validateCli.errors));
  for (const path of ['/src/a.ts', '../src/a.ts', 'src/../a.ts', 'src/./a.ts', 'src//a.ts', 'src/', 'src/*.ts', 'src/a.?s', 'src/[a].ts', 'src/{a}.ts', 'src\\a.ts', 'src/a\0.ts']) {
    assert.equal(validateCli({ ...configInput(), allowNulTextPaths: [path] }), false, path);
  }
  assert.equal(validateCli({ ...configInput(), allowNulTextPaths: ['src/a.ts', 'src/a.ts'] }), false);
  const cliExample: unknown = JSON.parse(await readFile(join(exampleDirectory, 'porting-policy.json'), 'utf8'));
  const hostedExample: unknown = JSON.parse(await readFile(join(exampleDirectory, 'hosted-porting-policy.json'), 'utf8'));
  assert.equal(validateCli(cliExample), true, JSON.stringify(validateCli.errors));
  assert.equal(validateHosted(hostedExample), true, JSON.stringify(validateHosted.errors));
  assert.equal(validateHosted({ ...(hostedExample as Record<string, unknown>), allowNulTextPaths: ['src/spectrum.ts'] }), false, 'NUL allowance is CLI-only');

  assert.equal(validateInstructions({ goal: 'Valid 😀 goal', adaptation: [], nonGoals: [] }), true);
  assert.equal(validateInstructions({ goal: '😀'.repeat(4096) }), true);
  assert.equal(validateInstructions({ goal: '😀'.repeat(4097) }), false);
  assert.equal(validateInstructions({ goal: '\ud800' }), false);
  assert.equal(validateInstructions({ goal: 'bad\u0001control' }), false);
  assert.equal(validateInstructions({ goal: 'Line one\u2029Line two' }), false);
  assert.equal(validateInstructions({ goal: 'Valid goal', extraPermission: 'shell' }), false);

  const hostedWithCliSettings = { ...(hostedExample as Record<string, unknown>), opencode: { executable: 'opencode' } };
  assert.equal(validateHosted(hostedWithCliSettings), false, 'hosted policy schema must not accept CLI-only settings');
});
