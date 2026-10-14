import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repository = 'kyeshmz/oc-port-agent-live-test-20261010';
const prefix = `repos/${repository}`;
const evidencePath = join(root, 'evidence', 'repository.json');
const files = [
  'README.md', 'package.json', 'lib/strip-prefix.js',
  'lib/target-helpers.js', 'reference/bom.js', 'test/strip-prefix.test.mjs',
];

function api(path, body, method = 'POST') {
  const args = ['api', path];
  if (body !== undefined) args.push('--method', method, '--input', '-');
  const result = spawnSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
  });
  if (result.error || result.status !== 0) throw new Error(`GitHub request failed: ${path}`);
  return JSON.parse(result.stdout);
}

const repo = api(prefix);
assert.equal(repo.full_name, repository);
assert.equal(repo.private, true);
assert.equal(repo.default_branch, 'main');

let saved;
try {
  saved = JSON.parse(await readFile(evidencePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (saved) {
  assert.equal(saved.repository, repository);
  assert.equal(api(`${prefix}/git/ref/heads/main`).object.sha, saved.targetCommit);
  assert.equal(api(`${prefix}/git/ref/heads/upstream`).object.sha, saved.upstreamCommit);
  console.log(JSON.stringify({ status: 'already-prepared', ...saved }, null, 2));
} else {
  const original = api(`${prefix}/git/ref/heads/main`).object.sha;
  const originalCommit = api(`${prefix}/git/commits/${original}`);
  const originalTree = api(`${prefix}/git/trees/${originalCommit.tree.sha}`);
  assert.deepEqual(originalTree.tree.map(item => item.path), ['README.md']);

  const tree = [];
  for (const path of files) {
    tree.push({ path, mode: '100644', type: 'blob', content: await readFile(join(root, path), 'utf8') });
  }
  const targetTree = api(`${prefix}/git/trees`, { base_tree: originalCommit.tree.sha, tree });
  const target = api(`${prefix}/git/commits`, {
    message: 'Add fixed BOM adaptation fixture and trusted acceptance tests',
    tree: targetTree.sha, parents: [original],
  });
  api(`${prefix}/git/refs/heads/main`, { sha: target.sha, force: false }, 'PATCH');
  api(`${prefix}/git/refs`, { ref: 'refs/heads/upstream', sha: target.sha });

  const content = [
    'export function stripBom(value) {',
    "  if (typeof value !== 'string') throw new TypeError('value must be a string');",
    '  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;',
    '}', '',
  ].join('\n');
  const upstreamTree = api(`${prefix}/git/trees`, {
    base_tree: targetTree.sha,
    tree: [{ path: 'reference/bom.js', mode: '100644', type: 'blob', content }],
  });
  const upstream = api(`${prefix}/git/commits`, {
    message: 'Remove exactly one leading BOM in reference API',
    tree: upstreamTree.sha, parents: [target.sha],
  });
  api(`${prefix}/git/refs/heads/upstream`, { sha: upstream.sha, force: false }, 'PATCH');

  const comparison = api(`${prefix}/compare/${target.sha}...${upstream.sha}`);
  assert.deepEqual(comparison.files.map(file => file.filename), ['reference/bom.js']);
  const evidence = {
    repository, url: repo.html_url, private: true, preparedAt: new Date().toISOString(),
    targetBranch: 'main', targetCommit: target.sha,
    upstreamBranch: 'upstream', baselineCommit: target.sha, upstreamCommit: upstream.sha,
    selectedChangedPaths: ['reference/bom.js'],
    initialAcceptance: { passed: 2, failed: 1, expectedFailure: true },
    stages: { repositoryPrepared: true, appInstalled: false, backendDeployed: false, liveSyncPassed: false },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const registration = {
    installationId: 'REPLACE_WITH_SELECTED_REPOSITORY_INSTALLATION_ID',
    target: { owner: 'kyeshmz', name: 'oc-port-agent-live-test-20261010' },
    baseBranch: 'main',
    upstream: {
      repository: `https://github.com/${repository}.git`, ref: 'upstream', baselineCommit: target.sha,
    },
    policy: {
      version: 1,
      upstream: { repository: `https://github.com/${repository}.git`, ref: 'upstream' },
      selections: [{
        id: 'strip-prefix-bom', description: 'Adapt exact leading-BOM removal into the local target API.',
        upstreamPaths: ['reference/bom.js'], excludeUpstreamPaths: [],
        targetPaths: ['lib/strip-prefix.js'],
        acceptance: [
          'Remove exactly one leading U+FEFF and preserve repeated or interior BOMs.',
          'Preserve other contents, reject nonstrings with TypeError, and preserve the target-only helper.',
          'The fixed test suite passes unchanged.',
        ],
        mappings: [{ upstream: 'reference/bom.js', target: ['lib/strip-prefix.js'] }],
        instructions: {
          goal: "Make the target's existing stripPrefix API remove exactly one leading U+FEFF while preserving its current name, input contract, and return behavior.",
          adaptation: [
            'Adapt the upstream stripBom behavior to the local stripPrefix API; do not rename the target export to match the upstream function.',
            'Use the existing target implementation style and preserve the target-only helper without changing it.',
          ],
          nonGoals: [
            'Do not remove repeated or interior BOMs, normalize unrelated Unicode, or change nonstring TypeError behavior.',
            'Do not modify the fixed tests, package configuration, lib/target-helpers.js, or any path outside the declared targetPaths.',
          ],
        },
      }],
      preserve: ['Do not modify tests, package configuration, or lib/target-helpers.js.'],
      protectedPaths: ['test/**', 'package.json', 'lib/target-helpers.js', '.github/**'],
      verification: [{ command: 'node', args: ['--test', 'test/strip-prefix.test.mjs'], timeoutSeconds: 30 }],
      limits: {
        maxCommits: 10, maxChangedPaths: 20, maxFiles: 30, maxContextBytes: 30_000,
        maxFileBytes: 10_000, maxResponseBytes: 30_000, maxVerificationOutputBytes: 16_384,
        maxJobSeconds: 180, maxAttempts: 1, maxSteps: 15,
      },
    },
  };
  await writeFile(join(root, 'registration.template.json'), `${JSON.stringify(registration, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}
