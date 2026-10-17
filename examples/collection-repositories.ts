import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, runPublicRepositoryCollection } from './public-repositories.js';

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log('Usage: npm run test:collection -- --live [--model provider/model#variant]\nGather the existing pinned public test repos into ONE disposable target and proposal.\nNo GitHub writes. Real model calls require --live. Artifacts are retained.');
} else if (!options.live) {
  console.error('Collection integration requires --live; no network or model work was started.');
  process.exitCode = 1;
} else {
  const approvedTemp = process.env.OC_PORT_PUBLIC_TMPDIR ? resolve(process.env.OC_PORT_PUBLIC_TMPDIR) : join(tmpdir(), 'opencode');
  await mkdir(approvedTemp, { recursive: true });
  process.env.TMPDIR = approvedTemp;
  const artifactsRoot = await mkdtemp(join(approvedTemp, 'oc-port-collection-'));
  const evidence = await runPublicRepositoryCollection({ ...options, artifactsRoot });
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== 'passed') process.exitCode = 1;
}
