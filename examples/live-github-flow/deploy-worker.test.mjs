import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import {
  APPROVED_OPENCODE_KEY,
  LIVE_WORKER,
  LIVE_WORKER_PATHS,
  LiveWorkerControllerError,
  executeLiveWorkerDeployment,
  main,
  makeLiveWorkerConfig,
  verifyGitHubAppInstallation,
} from './deploy-worker.mjs'

const SYNTHETIC_OPENCODE_KEY = 'synthetic-only-open-code-key-not-a-real-credential'
const SYNTHETIC_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString()
const SYNTHETIC_WEBHOOK_SECRET = 'synthetic-webhook-secret-not-real'
const PRIVATE_KEY_FILE = JSON.stringify({
  appId: LIVE_WORKER.appId,
  slug: LIVE_WORKER.appSlug,
  privateKey: SYNTHETIC_PRIVATE_KEY,
  webhookSecret: SYNTHETIC_WEBHOOK_SECRET,
})

const APP_INFO = {
  id: LIVE_WORKER.appId,
  slug: LIVE_WORKER.appSlug,
  owner: { login: LIVE_WORKER.owner, type: 'User' },
  permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
  events: ['pull_request'],
}
const INSTALLATION_INFO = {
  id: LIVE_WORKER.installationId,
  app_id: LIVE_WORKER.appId,
  account: { login: LIVE_WORKER.owner, type: 'User' },
  target_type: 'User',
  repository_selection: 'selected',
  suspended_at: null,
}
const INSTALLATION_REPOSITORY = {
  total_count: 1,
  repositories: [{ full_name: LIVE_WORKER.repositoryFullName, private: true }],
}

function fileInfo(path, entry) {
  const isDir = entry.kind === 'directory'
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: entry.mode,
    size: entry.content ? Buffer.byteLength(entry.content) : 0,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => entry.kind === 'symlink',
  }
}

function enoent() {
  return Object.assign(new Error('synthetic not found'), { code: 'ENOENT' })
}

function makeVirtualFs(options = {}) {
  const files = new Map()
  files.set(LIVE_WORKER_PATHS.appCredentials, {
    kind: options.appCredentialSymlink ? 'symlink' : 'file',
    content: PRIVATE_KEY_FILE,
    mode: options.appCredentialMode ?? 0o100600,
  })
  if (options.existingConfig) files.set(LIVE_WORKER_PATHS.config, {
    kind: 'file', content: options.existingConfig, mode: 0o100600,
  })
  if (options.existingAdminToken) files.set(LIVE_WORKER_PATHS.adminToken, {
    kind: 'file', content: options.existingAdminToken, mode: 0o100600,
  })

  const fs = {
    async lstat(path) {
      if (path === LIVE_WORKER_PATHS.privateDirectory || path === LIVE_WORKER_PATHS.evidenceDirectory) {
        return {
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          mode: path === LIVE_WORKER_PATHS.privateDirectory ? 0o40700 : 0o40755,
          isDirectory: () => true,
          isFile: () => false,
    isSymbolicLink: () => false,
        }
      }
      const entry = files.get(path)
      if (!entry) throw enoent()
      return fileInfo(path, entry)
    },
    async stat(path) {
      return {
        isFile: () => true,
        isDirectory: () => false,
      }
    },
    async readFile(path) {
      const entry = files.get(path)
      if (!entry) throw enoent()
      return entry.content
    },
    async open(path, flags, mode) {
      if (flags === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      let content = ''
      let closed = false
      return {
        async writeFile(value) { content = String(value) },
        async sync() {},
        async close() {
          if (closed) return
          closed = true
          files.set(path, { kind: 'file', content, mode: mode | 0o100000 })
        },
      }
    },
    async link(source, destination) {
      if (files.has(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      const entry = files.get(source)
      if (!entry) throw enoent()
      files.set(destination, { ...entry })
    },
    async rename(source, destination) {
      const entry = files.get(source)
      if (!entry) throw enoent()
      files.set(destination, { ...entry })
      files.delete(source)
    },
    async chmod(path, mode) {
      const entry = files.get(path)
      if (!entry) throw enoent()
      entry.mode = (entry.mode & ~0o777) | mode
    },
    async rm(path, options = {}) {
      if (!files.has(path) && !options.force) throw enoent()
      files.delete(path)
    },
    async mkdir() {},
  }
  return { fs, files }
}

function jsonResult(value) {
  return { code: 0, stdout: JSON.stringify(value), stderr: '' }
}

function makeHarness(options = {}) {
  const virtual = makeVirtualFs(options)
  const calls = []
  const events = []
  const apiCalls = []
  const remote = {
    database: undefined,
    queues: new Map(),
    workerExists: options.workerExists === true,
    workerVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workerTag: undefined,
    workerMessage: undefined,
    workerVersion: undefined,
  }
  for (const queue of options.preexistingQueues ?? []) remote.queues.set(queue.name, { ...queue })

  const fetch = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    apiCalls.push({ path: url.pathname, method })
    if (url.pathname === '/app') {
      return Response.json(options.app ?? APP_INFO)
    }
    if (url.pathname === `/app/installations/${LIVE_WORKER.installationId}`) {
      return Response.json(options.installation ?? INSTALLATION_INFO)
    }
    if (url.pathname === `/app/installations/${LIVE_WORKER.installationId}/access_tokens` && method === 'POST') {
      const request = JSON.parse(init.body)
      events.push(['installation-token', request])
      return Response.json({ token: 'synthetic-installation-token' })
    }
    if (url.pathname === '/installation/repositories') {
      const auth = new Headers(init.headers).get('authorization')
      assert.equal(auth, 'Bearer synthetic-installation-token')
      return Response.json(options.repositories ?? INSTALLATION_REPOSITORY)
    }
    throw new Error('unexpected synthetic GitHub URL')
  }

  const renderQueues = page => {
    if (options.queueMalformedOutput) return { code: 0, stdout: 'unrecognized queue listing output\n', stderr: '' }
    if (options.queueMalformedRow && page === 1) {
      return { code: 0, stdout: '│ id │ name │ created_on │ producers │ consumers │\n│ bad-id │ malformed │ date │ 0 │ 0 │\n', stderr: '' }
    }
    let allQueues = [...remote.queues.values()]
    if (options.queueAlwaysNonempty) {
      allQueues = Array.from({ length: 30 }, (_value, index) => ({
        id: (index + 1).toString(16).padStart(32, '0'),
        name: `unrelated-${index + 1}`,
      }))
    }
    if (options.duplicateQueueRows && page === 1) {
      allQueues = [...allQueues, ...options.duplicateQueueRows]
    }
    const pageSize = options.queuePageSize ?? 100
    const rowsForPage = allQueues.slice((page - 1) * pageSize, page * pageSize)
    if (rowsForPage.length === 0) return { code: 0, stdout: '', stderr: '' }
    const rows = rowsForPage.map(queue => `│ ${queue.id} │ ${queue.name} │ 2026-10-10 │ 0 │ 0 │`)
    const table = `┌${'─'.repeat(34)}┬${'─'.repeat(42)}┬${'─'.repeat(14)}┬${'─'.repeat(12)}┬${'─'.repeat(12)}┐\n`
      + `│ id │ name │ created_on │ producers │ consumers │\n`
      + `├${'─'.repeat(34)}┼${'─'.repeat(42)}┼${'─'.repeat(14)}┼${'─'.repeat(12)}┼${'─'.repeat(12)}┤\n`
      + `${rows.join('\n')}\n`
      + `└${'─'.repeat(34)}┴${'─'.repeat(42)}┴${'─'.repeat(14)}┴${'─'.repeat(12)}┴${'─'.repeat(12)}┘\n`
    return { code: 0, stdout: table, stderr: '' }
  }

  const runCommand = async input => {
    const args = [...input.args]
    calls.push({ args, env: { ...input.env }, stdin: input.stdin })
    events.push(['wrangler', args[0], args[1]])
    if (args[0] === 'whoami') {
      const id = options.whoamiAccountId ?? LIVE_WORKER.accountId
      return jsonResult({ accounts: [{ id }] })
    }
    if (args[0] === 'versions' && args[1] === 'list') {
      if (options.failNextWorkerMetadata && remote.workerExists) {
        options.failNextWorkerMetadata = false
        return { code: 1, stdout: '', stderr: 'synthetic transient metadata failure' }
      }
      if (options.workerExists) return jsonResult([{ id: remote.workerVersionId, annotations: { 'workers/tag': 'unknown' } }])
      return jsonResult(remote.workerVersion ? [remote.workerVersion] : [])
    }
    if (args[0] === 'deployments' && args[1] === 'list') {
      if (options.workerExists) return jsonResult([{ created_on: '2026-10-10T00:00:00.000Z', versions: [{ version_id: remote.workerVersionId, percentage: 100 }] }])
      return jsonResult(remote.workerVersion ? [{
        created_on: '2026-10-10T00:00:00.000Z',
        versions: [{ version_id: remote.workerVersionId, percentage: 100 }],
      }] : [])
    }
    if (args[0] === 'd1' && args[1] === 'list') {
      return jsonResult(remote.database ? [{ name: remote.database.name, uuid: remote.database.id }] : [])
    }
    if (args[0] === 'queues' && args[1] === 'list') {
      return renderQueues(Number(args[args.indexOf('--page') + 1]))
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      const name = args[2]
      if (remote.database) return { code: 1, stdout: '', stderr: 'database already exists' }
      remote.database = { name, id: '11111111-1111-4111-8111-111111111111' }
      return { code: 0, stdout: 'created synthetic D1', stderr: '' }
    }
    if (args[0] === 'queues' && args[1] === 'create') {
      const name = args[2]
      if (options.mainQueueFailure && name.endsWith('-jobs')) {
        return { code: 1, stdout: '', stderr: 'synthetic queue create failure' }
      }
      if (remote.queues.has(name)) return { code: 1, stdout: '', stderr: 'queue exists' }
      const id = remote.queues.size === 0
        ? '22222222222222222222222222222222'
        : '33333333-3333-4333-8333-333333333333'
      remote.queues.set(name, { name, id })
      return { code: 0, stdout: 'created synthetic queue', stderr: '' }
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') {
      assert.ok(args.includes('--remote'))
      assert.ok(args.includes('--config'))
      return { code: 0, stdout: 'applied synthetic migration', stderr: '' }
    }
    if (args[0] === 'deploy') {
      assert.ok(args.includes('--secrets-file'))
      assert.equal(args[args.indexOf('--secrets-file') + 1], '/dev/stdin')
      assert.equal(Object.values(input.env).includes(SYNTHETIC_OPENCODE_KEY), false)
      assert.equal(args.includes(SYNTHETIC_OPENCODE_KEY), false)
      const secrets = JSON.parse(input.stdin)
      assert.deepEqual(Object.keys(secrets).sort(), [
        'ADMIN_TOKEN', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'OPENCODE_API_KEY',
      ].sort())
      assert.equal(secrets.GITHUB_PRIVATE_KEY, SYNTHETIC_PRIVATE_KEY)
      assert.equal(secrets.GITHUB_WEBHOOK_SECRET, SYNTHETIC_WEBHOOK_SECRET)
      assert.equal(secrets.OPENCODE_API_KEY, SYNTHETIC_OPENCODE_KEY)
      assert.match(secrets.ADMIN_TOKEN, /^[A-Za-z0-9_-]{40,100}$/)
      assert.equal(secrets.OPENCODE_API_KEY.includes('synthetic-only'), true)
      remote.workerExists = true
      remote.workerTag = args[args.indexOf('--tag') + 1]
      remote.workerMessage = args[args.indexOf('--message') + 1]
      remote.workerVersion = {
        id: remote.workerVersionId,
        annotations: { 'workers/tag': remote.workerTag, 'workers/message': remote.workerMessage },
      }
      return {
        code: options.deployFailure ? 1 : 0,
        stdout: options.deployEchoesSecret ? SYNTHETIC_OPENCODE_KEY : 'deployed synthetic Worker',
        stderr: options.deployFailure ? SYNTHETIC_OPENCODE_KEY : '',
      }
    }
    if (args[0] === 'delete') throw new Error('controller must never delete resources')
    throw new Error(`unexpected synthetic Wrangler command: ${args.join(' ')}`)
  }

  const resolveCredential = async () => {
    events.push(['resolve-approved-opencode-key'])
    if (options.resolveError) throw options.resolveError
    return SYNTHETIC_OPENCODE_KEY
  }
  const dependencies = {
    fs: virtual.fs,
    runCommand,
    fetch,
    resolveCredential,
    environment: { CLOUDFLARE_ACCOUNT_ID: LIVE_WORKER.accountId, PATH: '/synthetic/path' },
    randomBytes: size => Buffer.alloc(size, 1),
    now: () => 1_791_600_000_000,
    writeEvidence: async (state, configDigest, versionId) => {
      events.push(['evidence', state.phase, configDigest, versionId])
    },
    writeResourceEvidence: async state => {
      events.push(['resource-evidence', state.phase, state.resourceSuffix, state.resources.d1.id])
    },
  }
  return { dependencies, virtual, calls, events, apiCalls, remote, resolveCredential }
}

test('provisioning is import-safe and requires the explicit execute flag', async () => {
  const harness = makeHarness()
  await assert.rejects(
    executeLiveWorkerDeployment({ dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'explicit-execute-required',
  )
  assert.equal(harness.calls.length, 0)
  assert.equal(harness.apiCalls.length, 0)

  const output = []
  const code = await main([], { log: value => output.push(value), error: value => output.push(value) })
  assert.equal(code, 2)
  assert.match(output[0], /No action taken/)
})

test('config targets only the dedicated account, public preview image, and one-slot resources', () => {
  const config = makeLiveWorkerConfig({
    databaseId: '11111111-1111-4111-8111-111111111111',
    databaseName: 'ocpa-live-test-20261010-010101010101-db',
    mainQueue: 'ocpa-live-test-20261010-010101010101-jobs',
    deadLetterQueue: 'ocpa-live-test-20261010-010101010101-dlq',
    migrationsDir: '/owned/checkout/apps/cloudflare/migrations',
  })
  assert.equal(config.account_id, LIVE_WORKER.accountId)
  assert.equal(config.name, LIVE_WORKER.workerName)
  assert.equal(config.main, '../../../apps/cloudflare/src/live-entry.ts')
  assert.equal(config.d1_databases[0].migrations_dir, '/owned/checkout/apps/cloudflare/migrations')
  assert.equal(config.containers[0].image, 'docker.io/cloudflare/sandbox:0.13.0-next.776.1-python')
  assert.equal(config.containers[0].max_instances, 1)
  assert.equal(config.queues.consumers[0].max_batch_size, 1)
  assert.equal(config.queues.consumers[0].max_concurrency, 1)
  assert.equal(config.queues.consumers[0].dead_letter_queue, 'ocpa-live-test-20261010-010101010101-dlq')
  assert.equal(Object.hasOwn(config, 'triggers'), false)
  assert.deepEqual(config.secrets.required, ['ADMIN_TOKEN', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'OPENCODE_API_KEY'])
  assert.equal(config.vars.OPENCODE_PROVIDER, 'opencode')
  assert.equal(config.vars.OPENCODE_MODEL, 'gpt-6-luna')
})

test('validates operator App identity and a single selected private repository via fixed GitHub API routes', async () => {
  const harness = makeHarness()
  const credentials = {
    appId: String(LIVE_WORKER.appId),
    slug: LIVE_WORKER.appSlug,
    privateKey: SYNTHETIC_PRIVATE_KEY,
    webhookSecret: SYNTHETIC_WEBHOOK_SECRET,
  }
  const result = await verifyGitHubAppInstallation(credentials, { fetch: harness.dependencies.fetch, now: harness.dependencies.now })
  assert.deepEqual(result, {
    appId: LIVE_WORKER.appId,
    slug: LIVE_WORKER.appSlug,
    installationId: LIVE_WORKER.installationId,
  })
  assert.deepEqual(harness.apiCalls.map(call => `${call.method} ${call.path}`), [
    'GET /app',
    `GET /app/installations/${LIVE_WORKER.installationId}`,
    `POST /app/installations/${LIVE_WORKER.installationId}/access_tokens`,
    'GET /installation/repositories',
  ])
  assert.deepEqual(harness.events.find(([event]) => event === 'installation-token')[1], {
    permissions: { metadata: 'read' },
  })
})

test('refuses App owner or installation repository mismatches before Wrangler writes or key resolution', async t => {
  for (const [name, overrides, expectedCode] of [
    ['owner', { app: { ...APP_INFO, owner: { login: 'someone-else', type: 'User' } } }, 'github-app-identity-or-scope-mismatch'],
    ['installation repository', { repositories: { total_count: 2, repositories: [
      { full_name: LIVE_WORKER.repositoryFullName, private: true },
      { full_name: 'kyeshmz/other', private: true },
    ] } }, 'github-installation-repository-scope-mismatch'],
  ]) {
    await t.test(name, async () => {
      const harness = makeHarness(overrides)
      await assert.rejects(
        executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
        error => error instanceof LiveWorkerControllerError && error.code === expectedCode,
      )
      assert.equal(harness.calls.some(call => call.args[0] === 'd1' && call.args[1] === 'create'), false)
      assert.equal(harness.calls.some(call => call.args[0] === 'queues' && call.args[1] === 'create'), false)
      assert.equal(harness.calls.some(call => call.args[0] === 'deploy'), false)
      assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
    })
  }
})

test('rejects an existing protected config before GitHub, Cloudflare, or credential resolution', async () => {
  const harness = makeHarness({ existingConfig: '{"unowned":true}\n' })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'unowned-protected-file-exists',
  )
  assert.equal(harness.apiCalls.length, 0)
  assert.equal(harness.calls.length, 0)
})

test('rejects wrong Cloudflare account metadata and never resolves the key', async () => {
  const harness = makeHarness({ whoamiAccountId: 'different-account' })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'cloudflare-account-identity-mismatch',
  )
  assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
  assert.equal(harness.calls.some(call => call.args[0] === 'd1' && call.args[1] === 'create'), false)
})

test('refuses an unknown Worker rather than deploying over it', async () => {
  const harness = makeHarness({ workerExists: true })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'unknown-worker-resource-exists',
  )
  assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
  assert.equal(harness.calls.some(call => call.args[0] === 'deploy'), false)
  assert.equal(harness.calls.some(call => call.args[0] === 'delete'), false)
})

test('provisions synthetic owned resources, passes secrets only on stdin, and resumes without redeploy', async () => {
  const harness = makeHarness({ deployEchoesSecret: true })
  let evidence
  harness.dependencies.writeEvidence = async (state, configDigest, versionId) => {
    evidence = { phase: state.phase, configDigest, versionId }
  }
  const result = await executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies })
  assert.equal(result.status, 'provisioned')
  assert.equal(result.runtimeCheckExecuted, false)
  assert.equal(result.modelCallExecuted, false)
  assert.equal(result.accountId, LIVE_WORKER.accountId)
  assert.equal(result.worker, LIVE_WORKER.workerName)
  assert.equal(result.d1.id, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(result.queues.map(queue => queue.id), [
    '22222222222222222222222222222222',
    '33333333-3333-4333-8333-333333333333',
  ])
  assert.equal(evidence.phase, 'deployed')
  assert.equal(evidence.versionId, result.workerVersionId)
  assert.deepEqual(harness.events.filter(([event]) => event === 'resource-evidence').map(([, phase]) => phase), [
    'd1-created', 'main-queue-created', 'resources-created', 'migrations-applied', 'deployment-succeeded', 'deployed',
  ])

  const deploy = harness.calls.find(call => call.args[0] === 'deploy')
  assert.ok(deploy)
  assert.equal(deploy.env.CLOUDFLARE_ACCOUNT_ID, LIVE_WORKER.accountId)
  assert.equal(Object.hasOwn(deploy.env, 'OPENCODE_API_KEY'), false)
  assert.equal(deploy.stdin.includes(SYNTHETIC_OPENCODE_KEY), true)
  assert.equal(deploy.args.includes(SYNTHETIC_OPENCODE_KEY), false)
  assert.equal(deploy.args.includes(SYNTHETIC_PRIVATE_KEY), false)
  assert.equal(deploy.args.includes(SYNTHETIC_WEBHOOK_SECRET), false)
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_OPENCODE_KEY), false)
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_PRIVATE_KEY), false)
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_WEBHOOK_SECRET), false)
  const stateText = harness.virtual.files.get(LIVE_WORKER_PATHS.state).content
  const configText = harness.virtual.files.get(LIVE_WORKER_PATHS.config).content
  assert.equal(stateText.includes(SYNTHETIC_OPENCODE_KEY), false)
  assert.equal(stateText.includes(SYNTHETIC_PRIVATE_KEY), false)
  assert.equal(stateText.includes(SYNTHETIC_WEBHOOK_SECRET), false)
  assert.equal(configText.includes(SYNTHETIC_OPENCODE_KEY), false)
  assert.equal(configText.includes(SYNTHETIC_PRIVATE_KEY), false)
  assert.equal(harness.calls.some(call => call.args[0] === 'delete'), false)

  const beforeResumeCommandCount = harness.calls.length
  const beforeResumeApiCount = harness.apiCalls.length
  const beforeResolveCount = harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length
  const beforeDeployCount = harness.calls.filter(call => call.args[0] === 'deploy').length
  const beforeD1CreateCount = harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'create').length
  const beforeQueueCreateCount = harness.calls.filter(call => call.args[0] === 'queues' && call.args[1] === 'create').length
  const beforeMigrationCount = harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'migrations').length
  harness.virtual.files.delete(LIVE_WORKER_PATHS.appCredentials)
  const resumed = await executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies })
  assert.equal(resumed.status, 'already-provisioned')
  assert.equal(resumed.workerVersionId, result.workerVersionId)
  assert.ok(harness.calls.length > beforeResumeCommandCount)
  assert.equal(harness.apiCalls.length, beforeResumeApiCount)
  assert.equal(harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length, beforeResolveCount)
  assert.equal(harness.calls.filter(call => call.args[0] === 'deploy').length, beforeDeployCount)
  assert.equal(harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'create').length, beforeD1CreateCount)
  assert.equal(harness.calls.filter(call => call.args[0] === 'queues' && call.args[1] === 'create').length, beforeQueueCreateCount)
  assert.equal(harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'migrations').length, beforeMigrationCount)
})

test('does not leak a Wrangler diagnostic that echoes stdin secrets', async () => {
  const harness = makeHarness({ deployEchoesSecret: true })
  const result = await executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies })
  const rendered = JSON.stringify(result)
  assert.equal(rendered.includes(SYNTHETIC_OPENCODE_KEY), false)
  assert.equal(rendered.includes(SYNTHETIC_PRIVATE_KEY), false)
  assert.equal(rendered.includes(SYNTHETIC_WEBHOOK_SECRET), false)
})

test('does not treat a failed Wrangler rollout as provisioned even if a tagged Worker version exists', async () => {
  const harness = makeHarness({ deployFailure: true, deployEchoesSecret: true })
  let evidenceWritten = false
  harness.dependencies.writeEvidence = async () => { evidenceWritten = true }
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError
      && error.code === 'wrangler-deploy-failed-partial-state-preserved'
      && !error.message.includes(SYNTHETIC_OPENCODE_KEY),
  )
  assert.equal(harness.remote.workerExists, true)
  assert.equal(evidenceWritten, false)
  assert.equal(harness.calls.some(call => call.args[0] === 'delete'), false)
  const saved = JSON.parse(harness.virtual.files.get(LIVE_WORKER_PATHS.state).content)
  assert.equal(saved.phase, 'deploying')
  assert.equal(saved.workerVersionId, undefined)
  assert.equal(harness.virtual.files.get(LIVE_WORKER_PATHS.state).content.includes(SYNTHETIC_OPENCODE_KEY), false)
})

test('recovers deployment-succeeded metadata without key resolution, migration, resource creation, or redeploy', async () => {
  const harness = makeHarness({ failNextWorkerMetadata: true })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'cloudflare-worker-version-metadata-unavailable',
  )
  const savedAfterTransientFailure = JSON.parse(harness.virtual.files.get(LIVE_WORKER_PATHS.state).content)
  assert.equal(savedAfterTransientFailure.phase, 'deployment-succeeded')
  assert.equal(savedAfterTransientFailure.configSha256.length, 64)
  assert.equal(savedAfterTransientFailure.resources.d1.id, '11111111-1111-4111-8111-111111111111')
  assert.equal(savedAfterTransientFailure.resources.mainQueue.id, '22222222222222222222222222222222')
  assert.equal(savedAfterTransientFailure.resources.deadLetterQueue.id, '33333333-3333-4333-8333-333333333333')

  const beforeCalls = harness.calls.length
  const beforeKeyResolution = harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length
  harness.virtual.files.delete(LIVE_WORKER_PATHS.appCredentials)
  const recovered = await executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies })
  assert.equal(recovered.status, 'already-provisioned')
  assert.equal(recovered.workerVersionId, harness.remote.workerVersionId)
  const recoveryCalls = harness.calls.slice(beforeCalls)
  assert.equal(recoveryCalls.some(call => call.args[0] === 'deploy'), false)
  assert.equal(recoveryCalls.some(call => call.args[0] === 'd1' && call.args[1] === 'create'), false)
  assert.equal(recoveryCalls.some(call => call.args[0] === 'queues' && call.args[1] === 'create'), false)
  assert.equal(recoveryCalls.some(call => call.args[0] === 'd1' && call.args[1] === 'migrations'), false)
  assert.equal(harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length, beforeKeyResolution)
  const finalState = JSON.parse(harness.virtual.files.get(LIVE_WORKER_PATHS.state).content)
  assert.equal(finalState.phase, 'deployed')
  assert.equal(finalState.workerVersionId, harness.remote.workerVersionId)
})

test('deployment-succeeded recovery still rejects config, version, and resource ownership mismatches', async t => {
  const cases = [
    ['config digest', harness => {
      const entry = harness.virtual.files.get(LIVE_WORKER_PATHS.config)
      entry.content = `${entry.content}\n`
    }, 'live-worker-config-does-not-match-owned-state'],
    ['active Worker version tag', harness => {
      harness.remote.workerVersion.annotations['workers/tag'] = 'ocpa-live-test-20261010-ffffffffffffffff'
    }, 'worker-deployment-version-unverified'],
    ['D1 resource ID', harness => {
      harness.remote.database.id = '44444444-4444-4444-8444-444444444444'
    }, 'owned-d1-resource-mismatch'],
  ]
  for (const [name, mismatch, code] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness({ failNextWorkerMetadata: true })
      await assert.rejects(
        executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
        error => error instanceof LiveWorkerControllerError && error.code === 'cloudflare-worker-version-metadata-unavailable',
      )
      const beforeResolveCount = harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length
      const beforeDeployCount = harness.calls.filter(call => call.args[0] === 'deploy').length
      const beforeD1CreateCount = harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'create').length
      const beforeQueueCreateCount = harness.calls.filter(call => call.args[0] === 'queues' && call.args[1] === 'create').length
      const beforeMigrationCount = harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'migrations').length
      mismatch(harness)
      await assert.rejects(
        executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
        error => error instanceof LiveWorkerControllerError && error.code === code,
      )
      assert.equal(harness.events.filter(([event]) => event === 'resolve-approved-opencode-key').length, beforeResolveCount)
      assert.equal(harness.calls.filter(call => call.args[0] === 'deploy').length, beforeDeployCount)
      assert.equal(harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'create').length, beforeD1CreateCount)
      assert.equal(harness.calls.filter(call => call.args[0] === 'queues' && call.args[1] === 'create').length, beforeQueueCreateCount)
      assert.equal(harness.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'migrations').length, beforeMigrationCount)
    })
  }
})

test('preserves and records the verified D1 owner if later Queue creation fails', async () => {
  const harness = makeHarness({ mainQueueFailure: true })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'main-queue-create-failed',
  )
  const saved = JSON.parse(harness.virtual.files.get(LIVE_WORKER_PATHS.state).content)
  assert.equal(saved.phase, 'creating-main-queue')
  assert.equal(saved.resources.d1.id, '11111111-1111-4111-8111-111111111111')
  assert.equal(saved.resources.mainQueue.id, null)
  assert.deepEqual(harness.events.filter(([event]) => event === 'resource-evidence').map(([, phase]) => phase), ['d1-created'])
  assert.equal(harness.remote.database.name, saved.resources.d1.name)
  assert.equal(harness.remote.queues.size, 0)
  assert.equal(harness.calls.some(call => call.args[0] === 'delete'), false)
})

test('discovers a conflicting opaque Queue ID on a later page before resolving the key', async () => {
  const queueName = 'ocpa-live-test-20261010-010101010101-jobs'
  const harness = makeHarness({
    queuePageSize: 1,
    preexistingQueues: [
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'unrelated-queue' },
      { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: queueName },
    ],
  })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError && error.code === 'queue-resource-ownership-indeterminate',
  )
  assert.equal(harness.calls.some(call => call.args[0] === 'queues' && call.args[1] === 'list' && call.args[3] === '2'), true)
  assert.equal(harness.calls.some(call => call.args[0] === 'queues' && call.args[1] === 'create'), false)
  assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
})

test('rejects unrecognized, malformed, duplicate, or page-unbounded queue metadata', async t => {
  const cases = [
    ['unrecognized output', { queueMalformedOutput: true }, 'cloudflare-queue-metadata-unrecognized-output'],
    ['malformed row', { queueMalformedRow: true }, 'cloudflare-queue-metadata-row-invalid'],
    ['duplicate names', {
      duplicateQueueRows: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'duplicate-name' },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'duplicate-name' },
      ],
    }, 'cloudflare-queue-metadata-duplicate'],
    ['duplicate IDs', {
      duplicateQueueRows: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'first-name' },
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'second-name' },
      ],
    }, 'cloudflare-queue-metadata-duplicate'],
    ['page bound', { queueAlwaysNonempty: true, queuePageSize: 1 }, 'cloudflare-queue-metadata-page-limit'],
  ]
  for (const [name, options, expectedCode] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness(options)
      await assert.rejects(
        executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
        error => error instanceof LiveWorkerControllerError && error.code === expectedCode,
      )
      assert.equal(harness.calls.some(call => call.args[0] === 'queues' && call.args[1] === 'create'), false)
      assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
    })
  }
})

test('reports a mismatch in the approved key resolver without exposing its error text', async () => {
  const harness = makeHarness({ resolveError: Object.assign(new Error(SYNTHETIC_OPENCODE_KEY), { code: SYNTHETIC_OPENCODE_KEY }) })
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
    error => error instanceof LiveWorkerControllerError
      && error.code === 'opencode-credential-resolution-failed'
      && !error.message.includes(SYNTHETIC_OPENCODE_KEY),
  )
  assert.equal(harness.calls.some(call => call.args[0] === 'd1' && call.args[1] === 'create'), false)
})

test('rejects symlinked or incorrectly permissioned App credential files before remote calls', async t => {
  for (const [name, options] of [
    ['symlink', { appCredentialSymlink: true }],
    ['mode', { appCredentialMode: 0o100644 }],
  ]) {
    await t.test(name, async () => {
      const harness = makeHarness(options)
      await assert.rejects(
        executeLiveWorkerDeployment({ execute: true, dependencies: harness.dependencies }),
        error => error instanceof LiveWorkerControllerError && error.code === 'app-credential-file-permissions-invalid',
      )
      assert.equal(harness.apiCalls.length, 0)
      assert.equal(harness.calls.length, 0)
      assert.equal(harness.events.some(([event]) => event === 'resolve-approved-opencode-key'), false)
    })
  }
})

test('checks inherited account selection and missing execute consent before touching dependencies', async () => {
  const harness = makeHarness()
  const wrongAccount = { ...harness.dependencies, environment: { CLOUDFLARE_ACCOUNT_ID: 'wrong' } }
  await assert.rejects(
    executeLiveWorkerDeployment({ execute: true, dependencies: wrongAccount }),
    error => error instanceof LiveWorkerControllerError && error.code === 'cloudflare-account-environment-mismatch',
  )
  assert.equal(harness.calls.length, 0)
  assert.equal(harness.apiCalls.length, 0)
  assert.equal(APPROVED_OPENCODE_KEY.credentialID, 'cred_ff5c3340d002t0edkOPNVJLA35')
})
