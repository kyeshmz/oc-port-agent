import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, mustRun } from './process.js';

export interface PublishOptions { repository: string; base: string }
export function remoteRepository(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
}
export async function publicationGate(root: string, options: PublishOptions, namespace: string): Promise<void> {
  if (!/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(options.repository)) throw new Error('--repo must be owner/repository');
  await git(root, ['check-ref-format', `refs/heads/${options.base}`]);
  const origin = (await git(root, ['remote', 'get-url', '--push', 'origin'])).trim();
  if (remoteRepository(origin)?.toLowerCase() !== options.repository.toLowerCase()) throw new Error('--repo must match the target repository origin; refusing to publish elsewhere');
  // Scheduled checks must start from the actual target base, not an arbitrary branch.
  await git(root, ['fetch', '--no-tags', 'origin', `refs/heads/${options.base}`]);
  const base = (await git(root, ['rev-parse', 'FETCH_HEAD'])).trim();
  const current = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (base !== current) throw new Error('PR publication must start from the freshly fetched target base commit. Check out the target base first.');
  const pages = JSON.parse(await mustRun('gh', ['api', '--paginate', '--slurp', `repos/${options.repository}/pulls?state=open&per_page=100`], root)) as { head: { ref: string }; html_url: string }[][];
  const existing = pages.flat().find(pr => pr.head.ref.startsWith(namespace));
  if (existing) throw new Error(`An upstream sync PR is already open: ${existing.html_url}. Review/merge/close it before another sync.`);
}

export async function publish(root: string, options: PublishOptions, branch: string, title: string, body: string): Promise<string> {
  const remote = (await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).trim();
  if (remote) throw new Error('The sync branch already exists on origin. Refusing to overwrite it or create a duplicate PR.');
  const bodyFile = join(root, '.oc-port', 'context', 'pr-body.md');
  await writeFile(bodyFile, body);
  // No force push and no automatic merge. Permissions/branch protection remain authoritative.
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${branch}`]);
  return (await mustRun('gh', ['pr', 'create', '--repo', options.repository, '--base', options.base, '--head', branch, '--draft', '--title', title, '--body-file', bodyFile], root)).trim();
}
