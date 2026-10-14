import { createPrivateKey, createSign, randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LIVE_WORKER = Object.freeze({
  accountId: '324e23339afefd2f1f689e735c2b8789',
  owner: 'kyeshmz',
  repository: 'oc-port-agent-live-test-20261010',
  repositoryFullName: 'kyeshmz/oc-port-agent-live-test-20261010',
  installationId: 170044765,
  appId: 5266090,
  appSlug: 'oc-port-agent-20261010',
  workerName: 'oc-port-agent-live-test-20261010',
  image: 'docker.io/cloudflare/sandbox:0.13.0-next.776.1-python',
  workersDevUrl: 'https://oc-port-agent-live-test-20261010.kye-324.workers.dev',
})

export const APPROVED_OPENCODE_KEY = Object.freeze({
  integrationID: 'opencode',
  credentialID: 'cred_ff5c3340d002t0edkOPNVJLA35',
  method: 'key',
  label: 'default',
})

const API_ORIGIN = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PRIVATE_KEY_MAX_BYTES = 16_384
const WEBHOOK_SECRET_MAX_BYTES = 2_048
const APP_FILE_MAX_BYTES = 40_000
const STATE_FILE_MAX_BYTES = 64_000
const COMMAND_OUTPUT_MAX_BYTES = 256_000
const COMMAND_TIMEOUT_MS = 60_000
const GITHUB_TIMEOUT_MS = 15_000
const MAX_QUEUE_PAGES = 20
const MAX_ADMIN_TOKEN_BYTES = 128
const STATE_FORMAT = 'ocpa-live-worker-state-v1'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')
const CLOUDFLARE_DIR = join(REPO_ROOT, 'apps', 'cloudflare')
const WRANGLER_ENTRY = join(CLOUDFLARE_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const PRIVATE_DIR = join(SCRIPT_DIR, '.private')
const APP_CREDENTIALS_PATH = join(PRIVATE_DIR, 'credentials.json')
const STATE_PATH = join(PRIVATE_DIR, 'live-worker-state.json')
const LIVE_CONFIG_PATH = join(PRIVATE_DIR, 'live-worker.wrangler.jsonc')
const ADMIN_TOKEN_PATH = join(PRIVATE_DIR, 'live-worker-admin-token')
const EVIDENCE_DIRECTORY = join(SCRIPT_DIR, 'evidence')

export const LIVE_WORKER_PATHS = Object.freeze({
  privateDirectory: PRIVATE_DIR,
  appCredentials: APP_CREDENTIALS_PATH,
  state: STATE_PATH,
  config: LIVE_CONFIG_PATH,
  adminToken: ADMIN_TOKEN_PATH,
  evidenceDirectory: EVIDENCE_DIRECTORY,
})

const STATE_PHASES = new Set([
  'new',
  'creating-d1',
  'd1-created',
  'creating-main-queue',
  'main-queue-created',
  'creating-dead-letter-queue',
  'resources-created',
  'migrations-applied',
  'deploying',
  'deployment-succeeded',
  'deployed',
])

const SAFE_OPENCODE_FAILURES = new Set([
  'opencode-plugin-package-unavailable',
  'opencode-sdk-package-unavailable',
  'opencode-host-startup-failed',
  'opencode-host-startup-timeout',
  'opencode-metadata-session-timeout',
  'opencode-integration-timeout',
  'opencode-integration-unavailable',
  'opencode-integration-metadata-invalid',
  'approved-credential-metadata-mismatch',
  'opencode-credential-resolution-timeout',
  'opencode-credential-resolution-failed',
  'approved-credential-value-invalid',
  'approved-temp-root-invalid',
  'approved-temp-root-unavailable',
  'owned-temp-directory-invalid',
  'owned-temp-directory-create-failed',
  'opencode-metadata-session-invalid',
  'opencode-plugin-not-activated',
  'opencode-plugin-setup-timeout',
  'approved-credential-not-resolved',
  'opencode-credential-setup-failed',
  'opencode-session-cleanup-timeout',
  'opencode-host-close-timeout',
  'opencode-credential-cleanup-failed',
])

export class LiveWorkerControllerError extends Error {
  constructor(code) {
    super(code)
    this.name = 'LiveWorkerControllerError'
    this.code = code
  }
}

function fail(code) {
  throw new LiveWorkerControllerError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonParse(value, code) {
  try {
    return JSON.parse(value)
  } catch {
    fail(code)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function validatePem(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= PRIVATE_KEY_MAX_BYTES
    && /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(value)
}

function validateWebhookSecret(value) {
  return typeof value === 'string' && value.length >= 16
    && Buffer.byteLength(value, 'utf8') <= WEBHOOK_SECRET_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validateAppCredentialObject(value) {
  if (!isRecord(value)) fail('app-credential-json-invalid')
  const allowedKeys = new Set(['appId', 'slug', 'privateKey', 'webhookSecret'])
  if (Object.keys(value).some(key => !allowedKeys.has(key))) fail('app-credential-file-has-unapproved-fields')
  if (value.appId !== LIVE_WORKER.appId || value.slug !== LIVE_WORKER.appSlug
    || !validatePem(value.privateKey) || !validateWebhookSecret(value.webhookSecret)) {
    fail('app-credential-metadata-invalid')
  }
  return {
    appId: String(value.appId),
    slug: value.slug,
    privateKey: value.privateKey,
    webhookSecret: value.webhookSecret,
  }
}

function makeAppJwt(credentials, now = Date.now()) {
  let key
  try {
    key = createPrivateKey({ key: credentials.privateKey, format: 'pem' })
  } catch {
    fail('app-private-key-invalid')
  }
  const issuedAt = Math.floor(now / 1_000) - 60
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: credentials.appId,
    iat: issuedAt,
    exp: issuedAt + 540,
  }))}`
  let signature
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    signer.end()
    signature = signer.sign(key).toString('base64url')
  } catch {
    fail('app-jwt-signing-failed')
  }
  return `${unsigned}.${signature}`
}

async function readBoundedResponse(response, maximumBytes) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        fail('github-response-limit')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function githubJson(fetchImpl, path, token, options = {}) {
  const url = new URL(path, API_ORIGIN)
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/')) fail('github-api-url-rejected')
  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'oc-port-agent-live-worker-controller/1.0',
  })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let body
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers.set('Content-Type', 'application/json')
  }
  let response
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
  } catch {
    fail('github-api-request-failed')
  }
  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => undefined)
    fail('github-api-response-rejected')
  }
  const bytes = await readBoundedResponse(response, 256_000)
  if (bytes.byteLength === 0) return undefined
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('github-response-utf8-invalid')
  }
  return jsonParse(text, 'github-response-json-invalid')
}

function validateAppMetadata(app) {
  if (!isRecord(app) || Number(app.id) !== LIVE_WORKER.appId || app.slug !== LIVE_WORKER.appSlug
    || !isRecord(app.owner) || String(app.owner.login).toLowerCase() !== LIVE_WORKER.owner
    || app.owner.type !== 'User'
    || !isRecord(app.permissions) || app.permissions.contents !== 'write'
    || app.permissions.pull_requests !== 'write' || app.permissions.metadata !== 'read'
    || !Array.isArray(app.events) || app.events.length !== 1 || app.events[0] !== 'pull_request') {
    fail('github-app-identity-or-scope-mismatch')
  }
  const effectivePermissions = Object.entries(app.permissions)
    .filter(([, value]) => value !== undefined && value !== null && value !== 'none')
    .map(([key]) => key)
    .sort()
  if (effectivePermissions.join(',') !== 'contents,metadata,pull_requests') {
    fail('github-app-permission-scope-mismatch')
  }
}

function validateInstallationMetadata(installation) {
  if (!isRecord(installation) || Number(installation.id) !== LIVE_WORKER.installationId
    || Number(installation.app_id) !== LIVE_WORKER.appId
    || installation.target_type !== 'User'
    || !isRecord(installation.account) || installation.account.type !== 'User'
    || String(installation.account.login).toLowerCase() !== LIVE_WORKER.owner
    || installation.repository_selection !== 'selected'
    || (installation.suspended_at !== undefined && installation.suspended_at !== null)) {
    fail('github-installation-identity-or-scope-mismatch')
  }
}

export async function verifyGitHubAppInstallation(credentials, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const jwt = makeAppJwt(credentials, now())
  const app = await githubJson(fetchImpl, '/app', jwt)
  validateAppMetadata(app)
  const installation = await githubJson(fetchImpl, `/app/installations/${LIVE_WORKER.installationId}`, jwt)
  validateInstallationMetadata(installation)

  const tokenResponse = await githubJson(fetchImpl, `/app/installations/${LIVE_WORKER.installationId}/access_tokens`, jwt, {
    method: 'POST',
    body: { permissions: { metadata: 'read' } },
  })
  if (!isRecord(tokenResponse) || typeof tokenResponse.token !== 'string' || tokenResponse.token.length < 1) {
    fail('github-installation-token-unavailable')
  }
  const repositories = await githubJson(fetchImpl, '/installation/repositories?per_page=100&page=1', tokenResponse.token)
  if (!isRecord(repositories) || repositories.total_count !== 1 || !Array.isArray(repositories.repositories)
    || repositories.repositories.length !== 1) {
    fail('github-installation-repository-scope-mismatch')
  }
  const repository = repositories.repositories[0]
  if (!isRecord(repository) || typeof repository.full_name !== 'string'
    || repository.full_name.toLowerCase() !== LIVE_WORKER.repositoryFullName
    || repository.private !== true) {
    fail('github-installation-repository-scope-mismatch')
  }
  return Object.freeze({ appId: LIVE_WORKER.appId, slug: LIVE_WORKER.appSlug, installationId: LIVE_WORKER.installationId })
}

function cloudflareChildEnvironment(source = process.env) {
  const permitted = [
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'CLOUDFLARE_CONFIG_DIR',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_AUTH_USE_KEYRING',
  ]
  const result = {}
  for (const key of permitted) {
    if (typeof source[key] === 'string') result[key] = source[key]
  }
  result.CLOUDFLARE_ACCOUNT_ID = LIVE_WORKER.accountId
  result.WRANGLER_SEND_METRICS = 'false'
  result.NO_COLOR = '1'
  return result
}

function spawnWrangler(options) {
  const args = options.args
  const cwd = options.cwd ?? REPO_ROOT
  const env = options.env ?? cloudflareChildEnvironment()
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? COMMAND_OUTPUT_MAX_BYTES

  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(process.execPath, [WRANGLER_ENTRY, ...args], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      rejectPromise(new LiveWorkerControllerError('wrangler-process-start-failed'))
      return
    }

    const stdout = []
    const stderr = []
    let totalBytes = 0
    let settled = false
    let timedOut = false
    let outputTooLarge = false
    const finishReject = code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new LiveWorkerControllerError(code))
    }
    const addOutput = (chunks, chunk) => {
      totalBytes += chunk.byteLength
      if (totalBytes > maxOutputBytes) {
        outputTooLarge = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    child.stdout.on('data', chunk => addOutput(stdout, chunk))
    child.stderr.on('data', chunk => addOutput(stderr, chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', () => finishReject('wrangler-process-failed'))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outputTooLarge) {
        rejectPromise(new LiveWorkerControllerError('wrangler-output-limit'))
        return
      }
      if (timedOut) {
        rejectPromise(new LiveWorkerControllerError('wrangler-timeout'))
        return
      }
      resolvePromise({
        code: Number.isInteger(code) ? code : 1,
        signal: typeof signal === 'string' ? signal : undefined,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })

    if (typeof options.stdin === 'string') child.stdin.end(options.stdin, 'utf8')
    else child.stdin.end()
  })
}

async function runWrangler(dependencies, args, options = {}) {
  const result = await dependencies.runCommand({
    args,
    cwd: options.cwd ?? REPO_ROOT,
    env: cloudflareChildEnvironment(dependencies.environment ?? process.env),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? COMMAND_OUTPUT_MAX_BYTES,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  })
  if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail('wrangler-result-invalid')
  }
  return result
}

async function assertPrivateDirectory(fs = { lstat, mkdir, chmod }) {
  let info
  try {
    info = await fs.lstat(PRIVATE_DIR)
  } catch {
    fail('private-directory-unavailable')
  }
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (info.mode & 0o777) !== 0o700) {
    fail('private-directory-permissions-invalid')
  }
}

async function assertEvidenceDirectory(fs = { lstat }) {
  let info
  try {
    info = await fs.lstat(EVIDENCE_DIRECTORY)
  } catch {
    fail('evidence-directory-unavailable')
  }
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (info.mode & 0o022) !== 0) {
    fail('evidence-directory-permissions-invalid')
  }
}

async function readProtectedFile(path, options = {}) {
  const fs = options.fs ?? { lstat, readFile }
  const maxBytes = options.maxBytes ?? APP_FILE_MAX_BYTES
  const requiredMode = options.requiredMode ?? 0o600
  let info
  try {
    info = await fs.lstat(path)
  } catch {
    fail(options.missingCode ?? 'protected-file-missing')
  }
  if (!info.isFile() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (info.mode & 0o777) !== requiredMode || info.size < 1 || info.size > maxBytes) {
    fail(options.invalidCode ?? 'protected-file-permissions-invalid')
  }
  let content
  try {
    content = await fs.readFile(path, 'utf8')
  } catch {
    fail(options.readCode ?? 'protected-file-read-failed')
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) fail(options.invalidCode ?? 'protected-file-permissions-invalid')
  return content
}

async function loadAppCredentials(options = {}) {
  const content = await readProtectedFile(APP_CREDENTIALS_PATH, {
    ...options,
    maxBytes: APP_FILE_MAX_BYTES,
    requiredMode: 0o600,
    missingCode: 'app-credential-file-missing',
    invalidCode: 'app-credential-file-permissions-invalid',
    readCode: 'app-credential-file-read-failed',
  })
  return validateAppCredentialObject(jsonParse(content, 'app-credential-json-invalid'))
}

export function makeLiveWorkerConfig(input) {
  if (!isRecord(input) || !/^[0-9a-f-]{36}$/i.test(input.databaseId)
    || typeof input.databaseName !== 'string' || !/^ocpa-live-test-20261010-[a-f0-9]{12}-db$/.test(input.databaseName)
    || typeof input.mainQueue !== 'string' || !/^ocpa-live-test-20261010-[a-f0-9]{12}-jobs$/.test(input.mainQueue)
    || typeof input.deadLetterQueue !== 'string' || !/^ocpa-live-test-20261010-[a-f0-9]{12}-dlq$/.test(input.deadLetterQueue)
    || typeof input.migrationsDir !== 'string' || !input.migrationsDir.startsWith('/')) {
    fail('live-worker-config-input-invalid')
  }
  return {
    $schema: join(CLOUDFLARE_DIR, 'node_modules', 'wrangler', 'config-schema.json'),
    name: LIVE_WORKER.workerName,
    account_id: LIVE_WORKER.accountId,
    main: '../../../apps/cloudflare/src/live-entry.ts',
    compatibility_date: '2026-10-09',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    vars: {
      GITHUB_APP_ID: String(LIVE_WORKER.appId),
      OPENCODE_PROVIDER: 'opencode',
      OPENCODE_MODEL: 'gpt-6-luna',
    },
    secrets: {
      required: ['ADMIN_TOKEN', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'OPENCODE_API_KEY'],
    },
    d1_databases: [{
      binding: 'DB',
      database_name: input.databaseName,
      database_id: input.databaseId,
      migrations_dir: input.migrationsDir,
    }],
    queues: {
      producers: [{ binding: 'JOB_QUEUE', queue: input.mainQueue }],
      consumers: [{
        queue: input.mainQueue,
        max_batch_size: 1,
        max_batch_timeout: 5,
        max_retries: 1,
        dead_letter_queue: input.deadLetterQueue,
        max_concurrency: 1,
        retry_delay: 30,
      }],
    },
    durable_objects: {
      bindings: [
        { name: 'TARGET_JOBS', class_name: 'TargetJobDO' },
        { name: 'SANDBOX', class_name: 'Sandbox' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TargetJobDO', 'Sandbox'] }],
    containers: [{
      class_name: 'Sandbox',
      image: LIVE_WORKER.image,
      max_instances: 1,
      instance_type: 'standard-1',
    }],
    observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1 }, traces: { enabled: false } },
  }
}

function validateResourceSuffix(value) {
  return typeof value === 'string' && /^[a-f0-9]{12}$/.test(value)
}

function validateState(state) {
  const allowed = new Set([
    'format', 'version', 'accountId', 'owner', 'repository', 'workerName', 'appId', 'installationId',
    'resourceSuffix', 'phase', 'resources', 'configSha256', 'adminTokenSha256', 'workerVersionId', 'workerTag', 'github',
  ])
  if (!isRecord(state) || state.format !== STATE_FORMAT || state.version !== 1
    || Object.keys(state).some(key => !allowed.has(key))
    || state.accountId !== LIVE_WORKER.accountId || state.owner !== LIVE_WORKER.owner
    || state.repository !== LIVE_WORKER.repositoryFullName || state.workerName !== LIVE_WORKER.workerName
    || state.appId !== LIVE_WORKER.appId || state.installationId !== LIVE_WORKER.installationId
    || !STATE_PHASES.has(state.phase) || !validateResourceSuffix(state.resourceSuffix)
    || !isRecord(state.resources) || !isRecord(state.resources.d1)
    || !isRecord(state.resources.mainQueue) || !isRecord(state.resources.deadLetterQueue)) {
    fail('owned-state-invalid')
  }
  const suffix = state.resourceSuffix
  for (const key of ['d1', 'mainQueue', 'deadLetterQueue']) {
    const resource = state.resources[key]
    if (!isRecord(resource) || Object.keys(resource).some(field => field !== 'name' && field !== 'id')) {
      fail('owned-state-resource-invalid')
    }
  }
  if (state.resources.d1.name !== `ocpa-live-test-20261010-${suffix}-db`
    || state.resources.mainQueue.name !== `ocpa-live-test-20261010-${suffix}-jobs`
    || state.resources.deadLetterQueue.name !== `ocpa-live-test-20261010-${suffix}-dlq`) {
    fail('owned-state-resource-name-mismatch')
  }
  for (const resource of [state.resources.d1, state.resources.mainQueue, state.resources.deadLetterQueue]) {
    if (resource.id !== null && (typeof resource.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(resource.id))) {
      fail('owned-state-resource-id-invalid')
    }
  }
  if (state.configSha256 !== undefined && (typeof state.configSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.configSha256))) {
    fail('owned-state-config-digest-invalid')
  }
  if (state.adminTokenSha256 !== undefined && (typeof state.adminTokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.adminTokenSha256))) {
    fail('owned-state-admin-token-digest-invalid')
  }
  if (state.workerVersionId !== undefined && (typeof state.workerVersionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(state.workerVersionId))) {
    fail('owned-state-worker-version-invalid')
  }
  if (state.workerTag !== undefined && (typeof state.workerTag !== 'string' || !/^ocpa-live-test-20261010-[a-f0-9]{16}$/.test(state.workerTag))) {
    fail('owned-state-worker-tag-invalid')
  }
  if (state.github !== undefined && (!isRecord(state.github)
    || Object.keys(state.github).some(key => !['appId', 'slug', 'installationId'].includes(key))
    || state.github.appId !== LIVE_WORKER.appId || state.github.slug !== LIVE_WORKER.appSlug
    || state.github.installationId !== LIVE_WORKER.installationId)) {
    fail('owned-state-github-metadata-invalid')
  }
  return state
}

function newState(suffix) {
  return {
    format: STATE_FORMAT,
    version: 1,
    accountId: LIVE_WORKER.accountId,
    owner: LIVE_WORKER.owner,
    repository: LIVE_WORKER.repositoryFullName,
    workerName: LIVE_WORKER.workerName,
    appId: LIVE_WORKER.appId,
    installationId: LIVE_WORKER.installationId,
    resourceSuffix: suffix,
    phase: 'new',
    resources: {
      d1: { name: `ocpa-live-test-20261010-${suffix}-db`, id: null },
      mainQueue: { name: `ocpa-live-test-20261010-${suffix}-jobs`, id: null },
      deadLetterQueue: { name: `ocpa-live-test-20261010-${suffix}-dlq`, id: null },
    },
  }
}

async function loadOwnedState(options = {}) {
  let info
  try {
    info = await (options.fs?.lstat ?? lstat)(STATE_PATH)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    fail('owned-state-stat-failed')
  }
  if (!info.isFile() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > STATE_FILE_MAX_BYTES) {
    fail('owned-state-permissions-invalid')
  }
  const content = await readProtectedFile(STATE_PATH, {
    fs: options.fs,
    maxBytes: STATE_FILE_MAX_BYTES,
    requiredMode: 0o600,
    invalidCode: 'owned-state-permissions-invalid',
    readCode: 'owned-state-read-failed',
  })
  return validateState(jsonParse(content, 'owned-state-json-invalid'))
}

async function atomicWriteProtected(path, content, options = {}) {
  const fs = options.fs ?? { open, rename, lstat, chmod, rm }
  const existing = options.existing === true
  const suffix = (options.randomBytes ?? randomBytes)(8).toString('hex')
  const temp = `${path}.${suffix}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (existing) {
      const info = await fs.lstat(path)
      if (!info.isFile() || info.isSymbolicLink()
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())
        || (info.mode & 0o777) !== 0o600) fail('owned-file-replacement-refused')
      await fs.rename(temp, path)
    } else {
      // link() supplies exclusive creation semantics; rename() would replace an unknown file.
      const linkImpl = options.link ?? fs.link ?? (await import('node:fs/promises')).link
      await linkImpl(temp, path)
      await fs.rm(temp, { force: true })
    }
    await fs.chmod(path, 0o600)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true }).catch(() => undefined)
    if (error instanceof LiveWorkerControllerError) throw error
    fail(options.code ?? 'protected-file-write-failed')
  }
}

async function saveState(state, options = {}) {
  validateState(state)
  const next = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(next, 'utf8') > STATE_FILE_MAX_BYTES) fail('owned-state-size-limit')
  const existing = options.existing ?? (state.phase !== 'new' || state.adminTokenSha256 !== undefined)
  await atomicWriteProtected(STATE_PATH, next, {
    fs: options.fs,
    existing,
    randomBytes: options.randomBytes,
    code: 'owned-state-write-failed',
  })
}

async function loadOrCreateAdminToken(state, options = {}) {
  const fs = options.fs ?? { open, lstat, readFile, chmod, rm }
  if (state.adminTokenSha256) {
    const content = await readProtectedFile(ADMIN_TOKEN_PATH, {
      fs,
      maxBytes: MAX_ADMIN_TOKEN_BYTES,
      requiredMode: 0o600,
      missingCode: 'owned-admin-token-missing',
      invalidCode: 'owned-admin-token-permissions-invalid',
      readCode: 'owned-admin-token-read-failed',
    })
    const token = content.trim()
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token) || sha256(token) !== state.adminTokenSha256) {
      fail('owned-admin-token-mismatch')
    }
    return token
  }

  try {
    await fs.lstat(ADMIN_TOKEN_PATH)
    fail('unowned-admin-token-file-exists')
  } catch (error) {
    if (error instanceof LiveWorkerControllerError) throw error
    if (error?.code !== 'ENOENT') fail('owned-admin-token-stat-failed')
  }
  const token = (options.randomBytes ?? randomBytes)(32).toString('base64url')
  await atomicWriteProtected(ADMIN_TOKEN_PATH, `${token}\n`, {
    fs,
    existing: false,
    randomBytes: options.randomBytes,
    code: 'owned-admin-token-write-failed',
  })
  state.adminTokenSha256 = sha256(token)
  await saveState(state, { ...options, existing: true })
  return token
}

function parseJsonOutput(result, code) {
  if (result.code !== 0) fail(code)
  return jsonParse(result.stdout, code)
}

function accountIdFromWhoami(data) {
  const candidates = []
  if (Array.isArray(data?.accounts)) candidates.push(...data.accounts)
  if (isRecord(data?.account)) candidates.push(data.account)
  if (isRecord(data?.user) && Array.isArray(data.user.accounts)) candidates.push(...data.user.accounts)
  return candidates.some(account => isRecord(account) && String(account.id) === LIVE_WORKER.accountId)
}

async function verifyCloudflareAccount(dependencies) {
  if (dependencies.environment?.CLOUDFLARE_ACCOUNT_ID
    && dependencies.environment.CLOUDFLARE_ACCOUNT_ID !== LIVE_WORKER.accountId) {
    fail('cloudflare-account-environment-mismatch')
  }
  const result = await runWrangler(dependencies, ['whoami', '--json', '--account', LIVE_WORKER.accountId])
  const account = parseJsonOutput(result, 'cloudflare-authentication-unavailable')
  if (!accountIdFromWhoami(account)) fail('cloudflare-account-identity-mismatch')
  return { accountId: LIVE_WORKER.accountId }
}

function parseD1List(result) {
  const parsed = parseJsonOutput(result, 'cloudflare-d1-metadata-unavailable')
  if (Array.isArray(parsed)) return parsed
  if (isRecord(parsed) && Array.isArray(parsed.result)) return parsed.result
  if (isRecord(parsed) && Array.isArray(parsed.databases)) return parsed.databases
  fail('cloudflare-d1-metadata-invalid')
}

async function readD1Databases(dependencies) {
  const result = await runWrangler(dependencies, ['d1', 'list', '--json'])
  return parseD1List(result).map(database => {
    if (!isRecord(database)) fail('cloudflare-d1-metadata-invalid')
    const name = database.name ?? database.database_name
    const id = database.uuid ?? database.database_id ?? database.id
    if (typeof name !== 'string' || typeof id !== 'string') fail('cloudflare-d1-metadata-invalid')
    return { name, id }
  })
}

const QUEUE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i

function tableCells(line) {
  if (!line.includes('│') && !line.includes('|')) return undefined
  return line.split(/[│|]/).map(cell => cell.trim())
}

function isTableBorder(line) {
  return /^[\s┌┐└┘├┤┬┴┼╭╮╰╯─━═+|│-]+$/u.test(line) && /[┌┐└┘├┤┬┴┼╭╮╰╯─━═+-]/u.test(line)
}

function isKnownWranglerBanner(line) {
  const normalized = line.replace(/[⛅️🌀✨]/gu, '').trim()
  return normalized === '' || /^wrangler(?:\s+\d+(?:\.\d+){1,3}(?:-[\w.-]+)?)?$/i.test(normalized)
    || /^[-─━]{3,}$/u.test(normalized)
}

function parseQueuePage(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > COMMAND_OUTPUT_MAX_BYTES) {
    fail('cloudflare-queue-metadata-invalid')
  }
  const lines = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  let headerIndex = -1
  let idIndex = -1
  let nameIndex = -1
  let headerWidth = 0
  for (let index = 0; index < lines.length; index++) {
    const cells = tableCells(lines[index] ?? '')
    if (!cells) continue
    const normalized = cells.map(cell => cell.toLowerCase())
    const idColumns = normalized.map((cell, cellIndex) => ({ cell, cellIndex }))
      .filter(({ cell }) => cell === 'id' || cell === 'queue_id')
    const nameColumns = normalized.map((cell, cellIndex) => ({ cell, cellIndex }))
      .filter(({ cell }) => cell === 'name' || cell === 'queue_name')
    if (idColumns.length > 0 || nameColumns.length > 0) {
      if (idColumns.length !== 1 || nameColumns.length !== 1 || headerIndex !== -1) {
        fail('cloudflare-queue-metadata-header-invalid')
      }
      headerIndex = index
      idIndex = idColumns[0].cellIndex
      nameIndex = nameColumns[0].cellIndex
      headerWidth = cells.length
    }
  }

  if (headerIndex === -1) {
    const remaining = lines.filter(line => !isKnownWranglerBanner(line) && !isTableBorder(line))
    if (remaining.length === 0) return { rows: [], empty: true }
    fail('cloudflare-queue-metadata-unrecognized-output')
  }

  const rows = []
  const seenIds = new Set()
  const seenNames = new Set()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (index === headerIndex || isKnownWranglerBanner(line) || isTableBorder(line)) continue
    const cells = tableCells(line)
    if (!cells) {
      if (line.trim() !== '') fail('cloudflare-queue-metadata-row-invalid')
      continue
    }
    if (cells.length !== headerWidth) fail('cloudflare-queue-metadata-row-invalid')
    const id = cells[idIndex] ?? ''
    const name = cells[nameIndex] ?? ''
    if (!QUEUE_ID.test(id) || !name || /[\u0000-\u001f\u007f]/.test(name)) {
      fail('cloudflare-queue-metadata-row-invalid')
    }
    const normalizedId = id.toLowerCase()
    if (seenIds.has(normalizedId) || seenNames.has(name)) fail('cloudflare-queue-metadata-duplicate')
    seenIds.add(normalizedId)
    seenNames.add(name)
    rows.push({ id: normalizedId, name })
  }
  return { rows, empty: rows.length === 0 }
}

async function readQueue(dependencies, queueName) {
  const matching = []
  let sawRows = false
  for (let page = 1; page <= MAX_QUEUE_PAGES; page++) {
    const result = await runWrangler(dependencies, ['queues', 'list', '--page', String(page)])
    if (result.code !== 0) fail('cloudflare-queue-metadata-unavailable')
    const parsed = parseQueuePage(result.stdout)
    if (parsed.empty) return matching.length > 1
      ? fail('cloudflare-queue-metadata-duplicate')
      : matching[0]
    sawRows = true
    matching.push(...parsed.rows.filter(row => row.name === queueName))
    if (matching.length > 1) fail('cloudflare-queue-metadata-duplicate')
  }
  if (sawRows) fail('cloudflare-queue-metadata-page-limit')
  return matching[0]
}

async function listQueuesForOwnedNames(dependencies, state) {
  const result = {}
  for (const key of ['mainQueue', 'deadLetterQueue']) result[key] = await readQueue(dependencies, state.resources[key].name)
  return result
}

function isKnownWorkerNotFound(result) {
  if (result.code === 0) return false
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase()
  return diagnostic.includes('worker') && (diagnostic.includes('not found') || diagnostic.includes('does not exist'))
}

async function readWorkerVersions(dependencies) {
  const result = await runWrangler(dependencies, ['versions', 'list', '--name', LIVE_WORKER.workerName, '--json'])
  if (result.code !== 0) {
    if (isKnownWorkerNotFound(result)) return undefined
    fail('cloudflare-worker-version-metadata-unavailable')
  }
  const parsed = jsonParse(result.stdout, 'cloudflare-worker-version-metadata-invalid')
  if (!Array.isArray(parsed)) fail('cloudflare-worker-version-metadata-invalid')
  for (const version of parsed) {
    if (!isRecord(version) || typeof version.id !== 'string' || !isRecord(version.annotations ?? {})) {
      fail('cloudflare-worker-version-metadata-invalid')
    }
  }
  return parsed
}

async function readWorkerDeployments(dependencies) {
  const result = await runWrangler(dependencies, ['deployments', 'list', '--name', LIVE_WORKER.workerName, '--json'])
  if (result.code !== 0) {
    if (isKnownWorkerNotFound(result)) return undefined
    fail('cloudflare-worker-deployment-metadata-unavailable')
  }
  const parsed = jsonParse(result.stdout, 'cloudflare-worker-deployment-metadata-invalid')
  if (!Array.isArray(parsed)) fail('cloudflare-worker-deployment-metadata-invalid')
  for (const deployment of parsed) {
    if (!isRecord(deployment) || !Array.isArray(deployment.versions)
      || deployment.versions.some(version => !isRecord(version) || typeof version.version_id !== 'string'
        || !Number.isFinite(version.percentage))) {
      fail('cloudflare-worker-deployment-metadata-invalid')
    }
  }
  return parsed
}

async function readWorkerMetadata(dependencies) {
  const [versions, deployments] = await Promise.all([
    readWorkerVersions(dependencies),
    readWorkerDeployments(dependencies),
  ])
  const versionList = versions ?? []
  const deploymentList = deployments ?? []
  return {
    exists: versionList.length > 0 || deploymentList.length > 0,
    versions: versionList,
    deployments: deploymentList,
  }
}

function assertNoUnknownResources(worker, databases, queues, state) {
  if (!state) fail('owned-state-required-for-resource-check')
  if (worker.exists && !['deploying', 'deployment-succeeded', 'deployed'].includes(state.phase)) {
    fail('unknown-worker-resource-exists')
  }
  const d1 = databases.find(item => item.name === state.resources.d1.name)
  if (state.resources.d1.id) {
    if (!d1 || d1.id !== state.resources.d1.id) fail('owned-d1-resource-mismatch')
  } else if (d1) {
    fail('d1-resource-ownership-indeterminate')
  }
  for (const key of ['mainQueue', 'deadLetterQueue']) {
    const queue = queues[key]
    const expected = state.resources[key]
    if (expected.id) {
      if (!queue || queue.id !== expected.id) fail('owned-queue-resource-mismatch')
    } else if (queue) {
      fail('queue-resource-ownership-indeterminate')
    }
  }
}

function deploymentContainsVersion(metadata, versionId) {
  const deployment = metadata.deployments.at(-1)
  if (!deployment) return false
  const version = deployment.versions.find(item => item.version_id === versionId)
  return version?.percentage === 100
}

function stateVersionMetadata(metadata, state) {
  if (!state.workerTag || !state.configSha256) return undefined
  const version = metadata.versions.find(candidate => candidate.annotations?.['workers/tag'] === state.workerTag
    && candidate.annotations?.['workers/message'] === `live-test-config-sha256:${state.configSha256}`)
  if (!version || !deploymentContainsVersion(metadata, version.id)) return undefined
  return version
}

function assertCurrentOwnedDeployment(metadata, state) {
  if (!state.workerVersionId || !state.workerTag || !state.configSha256) fail('owned-worker-deployment-state-incomplete')
  const version = metadata.versions.find(candidate => candidate.id === state.workerVersionId)
  if (!version || version.annotations?.['workers/tag'] !== state.workerTag
    || version.annotations?.['workers/message'] !== `live-test-config-sha256:${state.configSha256}`
    || !deploymentContainsVersion(metadata, state.workerVersionId)) {
    fail('owned-worker-version-mismatch')
  }
}

function validateConfigPath(configPath = LIVE_CONFIG_PATH) {
  const configDirectory = dirname(configPath)
  const absoluteMain = resolve(configDirectory, '../../../apps/cloudflare/src/live-entry.ts')
  if (absoluteMain !== join(CLOUDFLARE_DIR, 'src', 'live-entry.ts')) fail('live-worker-main-path-invalid')
}

function buildEvidence(state, configDigest, versionId, phase) {
  return {
    evidenceVersion: 1,
    status: phase,
    date: new Date().toISOString().slice(0, 10),
    remoteActionsOccurred: true,
    accountId: LIVE_WORKER.accountId,
    worker: LIVE_WORKER.workerName,
    workersDevUrl: LIVE_WORKER.workersDevUrl,
    appId: LIVE_WORKER.appId,
    appSlug: LIVE_WORKER.appSlug,
    installationId: LIVE_WORKER.installationId,
    repository: LIVE_WORKER.repositoryFullName,
    resources: {
      d1: { name: state.resources.d1.name, id: state.resources.d1.id },
      mainQueue: { name: state.resources.mainQueue.name, id: state.resources.mainQueue.id },
      deadLetterQueue: { name: state.resources.deadLetterQueue.name, id: state.resources.deadLetterQueue.id },
    },
    configSha256: configDigest,
    workerVersionId: versionId,
    image: LIVE_WORKER.image,
    maxQueueBatchSize: 1,
    maxQueueConcurrency: 1,
    maxSandboxInstances: 1,
    cronInitiallyEnabled: false,
    adminTokenFile: 'examples/live-github-flow/.private/live-worker-admin-token',
    runtimeCheckUrl: `${LIVE_WORKER.workersDevUrl}/admin/runtime-check`,
    runtimeCheckExecuted: false,
    modelCallExecuted: false,
    providerCredentialValueRecorded: false,
    appCredentialValueRecorded: false,
  }
}

async function writeEvidence(state, configDigest, versionId, dependencies) {
  const content = `${JSON.stringify(buildEvidence(state, configDigest, versionId, 'provisioned'), null, 2)}\n`
  const fs = dependencies.fs ?? { open, rename, lstat, chmod, rm, mkdir }
  await assertEvidenceDirectory(fs)
  const path = join(EVIDENCE_DIRECTORY, `live-worker-provisioning-${versionId}.json`)
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const suffix = (dependencies.randomBytes ?? randomBytes)(8).toString('hex')
  const temp = `${path}.${suffix}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    const linkImpl = fs.link ?? (await import('node:fs/promises')).link
    await linkImpl(temp, path)
    await fs.rm(temp, { force: true })
    await fs.chmod(path, 0o644)
  } catch {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true }).catch(() => undefined)
    fail('evidence-write-failed')
  }
  return `examples/live-github-flow/evidence/${basename(path)}`
}

async function writeResourceEvidence(state, dependencies) {
  const path = join(EVIDENCE_DIRECTORY, `live-worker-resources-${state.resourceSuffix}.json`)
  const evidence = {
    evidenceVersion: 1,
    phase: state.phase,
    date: new Date((dependencies.now ?? Date.now)()).toISOString().slice(0, 10),
    remoteActionsOccurred: true,
    accountId: LIVE_WORKER.accountId,
    worker: LIVE_WORKER.workerName,
    repository: LIVE_WORKER.repositoryFullName,
    appId: LIVE_WORKER.appId,
    appSlug: LIVE_WORKER.appSlug,
    installationId: LIVE_WORKER.installationId,
    resourceSuffix: state.resourceSuffix,
    resources: {
      d1: { ...state.resources.d1 },
      mainQueue: { ...state.resources.mainQueue },
      deadLetterQueue: { ...state.resources.deadLetterQueue },
    },
    configSha256: state.configSha256 ?? null,
    workerVersionId: state.workerVersionId ?? null,
    secretsRecorded: false,
    providerCredentialRecorded: false,
  }
  const content = `${JSON.stringify(evidence, null, 2)}\n`
  const fs = dependencies.fs ?? { open, lstat, readFile, rename, chmod, rm, mkdir }
  await assertEvidenceDirectory(fs)
  await fs.mkdir(EVIDENCE_DIRECTORY, { recursive: true })
  const suffix = (dependencies.randomBytes ?? randomBytes)(8).toString('hex')
  const temp = `${path}.${suffix}.tmp`
  let handle
  let ownedExistingFile = false
  try {
    const current = await fs.lstat(path)
    ownedExistingFile = true
    if (!current.isFile() || current.isSymbolicLink()
      || (typeof process.getuid === 'function' && current.uid !== process.getuid())
      || (current.mode & 0o777) !== 0o644 || current.size > 64_000) {
      fail('resource-evidence-ownership-invalid')
    }
    const previous = JSON.parse(await fs.readFile(path, 'utf8'))
    if (!isRecord(previous) || previous.evidenceVersion !== 1
      || previous.accountId !== LIVE_WORKER.accountId
      || previous.worker !== LIVE_WORKER.workerName
      || previous.repository !== LIVE_WORKER.repositoryFullName
      || previous.resourceSuffix !== state.resourceSuffix) {
      fail('resource-evidence-ownership-mismatch')
    }
  } catch (error) {
    if (error instanceof LiveWorkerControllerError) throw error
    if (error?.code !== 'ENOENT') fail('resource-evidence-read-failed')
  }

  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (ownedExistingFile) {
      await fs.rename(temp, path)
    } else {
      const linkImpl = fs.link ?? (await import('node:fs/promises')).link
      await linkImpl(temp, path)
      await fs.rm(temp, { force: true })
    }
    await fs.chmod(path, 0o644)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true }).catch(() => undefined)
    if (error instanceof LiveWorkerControllerError) throw error
    fail('resource-evidence-write-failed')
  }
}

function operationTag(configDigest) {
  return `ocpa-live-test-20261010-${configDigest.slice(0, 16)}`
}

function configContents(state) {
  const config = makeLiveWorkerConfig({
    databaseId: state.resources.d1.id,
    databaseName: state.resources.d1.name,
    mainQueue: state.resources.mainQueue.name,
    deadLetterQueue: state.resources.deadLetterQueue.name,
    migrationsDir: join(CLOUDFLARE_DIR, 'migrations'),
  })
  return `${JSON.stringify(config, null, 2)}\n`
}

function validateConfigTemplate(state) {
  const config = makeLiveWorkerConfig({
    databaseId: state.resources.d1.id ?? '11111111-1111-4111-8111-111111111111',
    databaseName: state.resources.d1.name,
    mainQueue: state.resources.mainQueue.name,
    deadLetterQueue: state.resources.deadLetterQueue.name,
    migrationsDir: join(CLOUDFLARE_DIR, 'migrations'),
  })
  if (config.account_id !== LIVE_WORKER.accountId || config.name !== LIVE_WORKER.workerName
    || config.main !== '../../../apps/cloudflare/src/live-entry.ts'
    || config.containers[0]?.image !== LIVE_WORKER.image
    || config.containers[0]?.max_instances !== 1
    || config.queues.consumers[0]?.max_batch_size !== 1
    || config.queues.consumers[0]?.max_concurrency !== 1
    || Object.hasOwn(config, 'triggers')) {
    fail('live-worker-config-template-invalid')
  }
  try {
    JSON.stringify(config)
  } catch {
    fail('live-worker-config-template-invalid')
  }
}

async function ensureConfig(state, dependencies) {
  validateConfigPath()
  const contents = configContents(state)
  const digest = sha256(contents)
  let existing
  try {
    existing = await readProtectedFile(LIVE_CONFIG_PATH, {
      fs: dependencies.fs,
      maxBytes: 64_000,
      requiredMode: 0o600,
      missingCode: 'live-worker-config-missing',
      invalidCode: 'live-worker-config-permissions-invalid',
      readCode: 'live-worker-config-read-failed',
    })
  } catch (error) {
    if (!(error instanceof LiveWorkerControllerError) || error.code !== 'live-worker-config-missing') throw error
  }
  if (existing !== undefined && existing !== contents) fail('live-worker-config-does-not-match-owned-state')
  if (existing === undefined) {
    await atomicWriteProtected(LIVE_CONFIG_PATH, contents, {
      fs: dependencies.fs,
      existing: false,
      randomBytes: dependencies.randomBytes,
      code: 'live-worker-config-write-failed',
    })
  }
  if (state.configSha256 && state.configSha256 !== digest) fail('owned-state-config-digest-mismatch')
  state.configSha256 = digest
  state.workerTag = operationTag(digest)
  await saveState(state, { ...dependencies, existing: true })
  return { contents, digest, path: LIVE_CONFIG_PATH }
}

async function assertFileAbsent(path, fs = { lstat }) {
  try {
    await fs.lstat(path)
    fail('unowned-protected-file-exists')
  } catch (error) {
    if (error instanceof LiveWorkerControllerError) throw error
    if (error?.code !== 'ENOENT') fail('protected-file-stat-failed')
  }
}

async function assertProtectedPrerequisites(state, dependencies) {
  validateConfigPath()
  const fs = dependencies.fs ?? { lstat }
  if (!state) {
    await assertFileAbsent(LIVE_CONFIG_PATH, fs)
    await assertFileAbsent(ADMIN_TOKEN_PATH, fs)
    return
  }

  if (state.adminTokenSha256) {
    const token = await readProtectedFile(ADMIN_TOKEN_PATH, {
      fs: dependencies.fs,
      maxBytes: MAX_ADMIN_TOKEN_BYTES,
      requiredMode: 0o600,
      missingCode: 'owned-admin-token-missing',
      invalidCode: 'owned-admin-token-permissions-invalid',
      readCode: 'owned-admin-token-read-failed',
    })
    if (sha256(token.trim()) !== state.adminTokenSha256) fail('owned-admin-token-mismatch')
  } else {
    await assertFileAbsent(ADMIN_TOKEN_PATH, fs)
  }

  let config
  try {
    config = await readProtectedFile(LIVE_CONFIG_PATH, {
      fs: dependencies.fs,
      maxBytes: 64_000,
      requiredMode: 0o600,
      missingCode: 'live-worker-config-missing',
      invalidCode: 'live-worker-config-permissions-invalid',
      readCode: 'live-worker-config-read-failed',
    })
  } catch (error) {
    if (!(error instanceof LiveWorkerControllerError) || error.code !== 'live-worker-config-missing') throw error
  }
  if (config !== undefined) {
    if (!['resources-created', 'migrations-applied', 'deploying', 'deployment-succeeded', 'deployed'].includes(state.phase)
      || state.resources.d1.id === null || state.resources.mainQueue.id === null
      || state.resources.deadLetterQueue.id === null) {
      fail('live-worker-config-ownership-indeterminate')
    }
    const expected = configContents(state)
    if (config !== expected || (state.configSha256 && sha256(config) !== state.configSha256)) {
      fail('live-worker-config-does-not-match-owned-state')
    }
  } else if (state.configSha256) {
    fail('owned-live-worker-config-missing')
  }
}

async function verifySources(dependencies) {
  const fs = dependencies.fs ?? { stat }
  const expected = [
    join(CLOUDFLARE_DIR, 'src', 'live-entry.ts'),
    join(CLOUDFLARE_DIR, 'src', 'github.ts'),
    join(CLOUDFLARE_DIR, 'src', 'sandbox.ts'),
    join(CLOUDFLARE_DIR, 'src', 'contracts.ts'),
    join(CLOUDFLARE_DIR, 'migrations', '0001_initial.sql'),
    join(CLOUDFLARE_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    join(CLOUDFLARE_DIR, 'node_modules', '@opencode', 'sdk', 'package.json'),
    join(CLOUDFLARE_DIR, 'node_modules', '@opencode', 'plugin', 'package.json'),
  ]
  for (const path of expected) {
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) fail('live-worker-source-missing')
    } catch (error) {
      if (error instanceof LiveWorkerControllerError) throw error
      fail('live-worker-source-missing')
    }
  }
}

async function validateQueueNamesFree(dependencies, state) {
  for (const key of ['mainQueue', 'deadLetterQueue']) {
    const found = await readQueue(dependencies, state.resources[key].name)
    if (found) fail('unknown-queue-resource-exists')
  }
}

async function validateD1NameFree(dependencies, state) {
  const databases = await readD1Databases(dependencies)
  if (databases.some(database => database.name === state.resources.d1.name)) fail('unknown-d1-resource-exists')
}

async function assertAccountAndRemoteState(dependencies, state) {
  await verifyCloudflareAccount(dependencies)
  const worker = await readWorkerMetadata(dependencies)
  const databases = await readD1Databases(dependencies)
  const queues = await listQueuesForOwnedNames(dependencies, state)
  assertNoUnknownResources(worker, databases, queues, state)
  return { worker, databases, queues }
}

async function finalizeSucceededDeployment(state, metadata, dependencies) {
  const version = stateVersionMetadata(metadata, state)
  if (!version) fail('worker-deployment-version-unverified')
  state.workerVersionId = version.id
  state.phase = 'deployed'
  await saveState(state, { ...dependencies, existing: true })
  await dependencies.writeResourceEvidence(state, dependencies)
  return version.id
}

function publicSummary(state, versionId, status) {
  return Object.freeze({
    status,
    accountId: LIVE_WORKER.accountId,
    worker: LIVE_WORKER.workerName,
    url: LIVE_WORKER.workersDevUrl,
    appId: LIVE_WORKER.appId,
    appSlug: LIVE_WORKER.appSlug,
    installationId: LIVE_WORKER.installationId,
    repository: LIVE_WORKER.repositoryFullName,
    d1: { name: state.resources.d1.name, id: state.resources.d1.id },
    queues: [
      { name: state.resources.mainQueue.name, id: state.resources.mainQueue.id },
      { name: state.resources.deadLetterQueue.name, id: state.resources.deadLetterQueue.id },
    ],
    workerVersionId: versionId,
    evidencePath: `examples/live-github-flow/evidence/live-worker-provisioning-${versionId}.json`,
    runtimeCheckUrl: `${LIVE_WORKER.workersDevUrl}/admin/runtime-check`,
    runtimeCheckExecuted: false,
    modelCallExecuted: false,
  })
}

async function continueProvisioning(state, dependencies, appCredentials, opencodeKey, adminToken) {
  let d1 = await readD1Databases(dependencies)
  let configuredQueueState = await listQueuesForOwnedNames(dependencies, state)
  const currentWorker = await readWorkerMetadata(dependencies)
  assertNoUnknownResources(currentWorker, d1, configuredQueueState, state)

  if (!state.resources.d1.id) {
    state.phase = 'creating-d1'
    await saveState(state, { ...dependencies, existing: true })
    const created = await runWrangler(dependencies, ['d1', 'create', state.resources.d1.name])
    if (created.code !== 0) fail('d1-create-failed')
    d1 = await readD1Databases(dependencies)
    const matches = d1.filter(database => database.name === state.resources.d1.name)
    if (matches.length !== 1 || !/^[0-9a-f-]{36}$/i.test(matches[0].id)) fail('d1-created-resource-unverified')
    state.resources.d1.id = matches[0].id
    state.phase = 'd1-created'
    await saveState(state, { ...dependencies, existing: true })
    await dependencies.writeResourceEvidence(state, dependencies)
  }

  if (!state.resources.mainQueue.id) {
    configuredQueueState = await listQueuesForOwnedNames(dependencies, state)
    if (configuredQueueState.mainQueue) fail('main-queue-ownership-indeterminate')
    state.phase = 'creating-main-queue'
    await saveState(state, { ...dependencies, existing: true })
    const created = await runWrangler(dependencies, ['queues', 'create', state.resources.mainQueue.name])
    if (created.code !== 0) fail('main-queue-create-failed')
    const found = await readQueue(dependencies, state.resources.mainQueue.name)
    if (!found) fail('main-queue-created-resource-unverified')
    state.resources.mainQueue.id = found.id
    state.phase = 'main-queue-created'
    await saveState(state, { ...dependencies, existing: true })
    await dependencies.writeResourceEvidence(state, dependencies)
  }

  if (!state.resources.deadLetterQueue.id) {
    configuredQueueState = await listQueuesForOwnedNames(dependencies, state)
    if (configuredQueueState.deadLetterQueue) fail('dead-letter-queue-ownership-indeterminate')
    state.phase = 'creating-dead-letter-queue'
    await saveState(state, { ...dependencies, existing: true })
    const created = await runWrangler(dependencies, ['queues', 'create', state.resources.deadLetterQueue.name])
    if (created.code !== 0) fail('dead-letter-queue-create-failed')
    const found = await readQueue(dependencies, state.resources.deadLetterQueue.name)
    if (!found) fail('dead-letter-queue-created-resource-unverified')
    state.resources.deadLetterQueue.id = found.id
    state.phase = 'resources-created'
    await saveState(state, { ...dependencies, existing: true })
    await dependencies.writeResourceEvidence(state, dependencies)
  }

  const config = await ensureConfig(state, dependencies)
  const beforeMigrationWorker = await readWorkerMetadata(dependencies)
  if (beforeMigrationWorker.exists) fail('unknown-worker-resource-exists')
  if (state.phase !== 'migrations-applied' && state.phase !== 'deploying' && state.phase !== 'deployed') {
    const migration = await runWrangler(dependencies, [
      'd1', 'migrations', 'apply', state.resources.d1.name, '--remote', '--config', config.path,
    ])
    if (migration.code !== 0) fail('d1-migration-apply-failed')
    state.phase = 'migrations-applied'
    await saveState(state, { ...dependencies, existing: true })
    await dependencies.writeResourceEvidence(state, dependencies)
  }

  const secretValues = {
    ADMIN_TOKEN: adminToken,
    GITHUB_PRIVATE_KEY: appCredentials.privateKey,
    GITHUB_WEBHOOK_SECRET: appCredentials.webhookSecret,
    OPENCODE_API_KEY: opencodeKey,
  }
  const secretJson = JSON.stringify(secretValues)
  for (const value of Object.values(secretValues)) {
    if (typeof value !== 'string' || value.length < 1) fail('secret-input-invalid')
  }

  const beforeDeployWorker = await readWorkerMetadata(dependencies)
  if (beforeDeployWorker.exists) fail('unknown-worker-resource-exists')
  state.workerTag = operationTag(config.digest)
  state.phase = 'deploying'
  await saveState(state, { ...dependencies, existing: true })
  const deployment = await runWrangler(dependencies, [
    'deploy',
    '--config', config.path,
    '--name', LIVE_WORKER.workerName,
    '--secrets-file', '/dev/stdin',
    '--tag', state.workerTag,
    '--message', `live-test-config-sha256:${config.digest}`,
    '--strict',
  ], { stdin: secretJson, timeoutMs: 180_000, maxOutputBytes: COMMAND_OUTPUT_MAX_BYTES })

  // Never forward, persist, or parse deploy stdout/stderr. It is treated as untrusted,
  // including in the unlikely event a CLI/runtime diagnostic echoes stdin.
  if (deployment.code !== 0) fail('wrangler-deploy-failed-partial-state-preserved')

  state.phase = 'deployment-succeeded'
  await saveState(state, { ...dependencies, existing: true })
  await dependencies.writeResourceEvidence(state, dependencies)
  const metadata = await readWorkerMetadata(dependencies)
  const versionId = await finalizeSucceededDeployment(state, metadata, dependencies)
  await dependencies.writeEvidence(state, config.digest, versionId, dependencies)
  return publicSummary(state, versionId, 'provisioned')
}

async function verifyDeployedResume(state, dependencies, metadata, databases, queues) {
  if (state.phase !== 'deployed') return undefined
  assertNoUnknownResources(metadata, databases, queues, state)
  assertCurrentOwnedDeployment(metadata, state)
  const config = await readProtectedFile(LIVE_CONFIG_PATH, {
    fs: dependencies.fs,
    maxBytes: 64_000,
    requiredMode: 0o600,
    missingCode: 'live-worker-config-missing',
    invalidCode: 'live-worker-config-permissions-invalid',
    readCode: 'live-worker-config-read-failed',
  })
  if (sha256(config) !== state.configSha256) fail('owned-state-config-digest-mismatch')
  const adminToken = await readProtectedFile(ADMIN_TOKEN_PATH, {
    fs: dependencies.fs,
    maxBytes: MAX_ADMIN_TOKEN_BYTES,
    requiredMode: 0o600,
    missingCode: 'owned-admin-token-missing',
    invalidCode: 'owned-admin-token-permissions-invalid',
    readCode: 'owned-admin-token-read-failed',
  })
  if (sha256(adminToken.trim()) !== state.adminTokenSha256) fail('owned-admin-token-mismatch')
  return publicSummary(state, state.workerVersionId, 'already-provisioned')
}

function makeDependencies(options = {}) {
  return {
    runCommand: options.runCommand ?? spawnWrangler,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    resolveCredential: options.resolveCredential,
    environment: options.environment ?? process.env,
    fs: options.fs,
    randomBytes: options.randomBytes ?? randomBytes,
    now: options.now ?? Date.now,
    writeEvidence: options.writeEvidence ?? writeEvidence,
    writeResourceEvidence: options.writeResourceEvidence ?? writeResourceEvidence,
    paths: options.paths,
  }
}

async function ensureTestOnlyPaths(dependencies) {
  if (dependencies.paths) {
    for (const [name, path] of Object.entries(dependencies.paths)) {
      if (typeof path !== 'string' || path.length === 0) fail(`test-path-${name}-invalid`)
    }
  }
}

/** Execute a reviewed provisioning pass. Nothing runs unless execute is exactly true. */
export async function executeLiveWorkerDeployment(options = {}) {
  if (options.execute !== true) fail('explicit-execute-required')
  const dependencies = makeDependencies(options.dependencies ?? {})
  await ensureTestOnlyPaths(dependencies)
  if (dependencies.environment?.CLOUDFLARE_ACCOUNT_ID
    && dependencies.environment.CLOUDFLARE_ACCOUNT_ID !== LIVE_WORKER.accountId) {
    fail('cloudflare-account-environment-mismatch')
  }
  await verifySources(dependencies)
  await assertPrivateDirectory(dependencies.fs)
  await assertEvidenceDirectory(dependencies.fs)

  const state = await loadOwnedState({ fs: dependencies.fs })
  await assertProtectedPrerequisites(state, dependencies)
  const configState = state ?? newState(dependencies.randomBytes(6).toString('hex'))
  validateConfigTemplate(configState)
  if (state?.phase === 'deployed' || state?.phase === 'deployment-succeeded') {
    const remote = await assertAccountAndRemoteState(dependencies, state)
    if (!remote.worker.exists) fail('owned-worker-missing')
    if (state.phase === 'deployment-succeeded') {
      const versionId = await finalizeSucceededDeployment(state, remote.worker, dependencies)
      await dependencies.writeEvidence(state, state.configSha256, versionId, dependencies)
      return publicSummary(state, versionId, 'already-provisioned')
    }
    return verifyDeployedResume(state, dependencies, remote.worker, remote.databases, remote.queues)
  }

  const activeState = configState
  if (!state) {
    const credentials = await loadAppCredentials({ fs: dependencies.fs })
    const remote = await assertAccountAndRemoteState(dependencies, activeState)
    if (remote.worker.exists) fail('unknown-worker-resource-exists')
    await validateD1NameFree(dependencies, activeState)
    await validateQueueNamesFree(dependencies, activeState)
    const app = await verifyGitHubAppInstallation(credentials, { fetch: dependencies.fetch, now: dependencies.now })
    const resolveCredential = dependencies.resolveCredential ?? (await import('./opencode-credential.mjs')).resolveApprovedOpenCodeCredential
    let opencodeKey
    try {
      opencodeKey = await resolveCredential()
    } catch (error) {
      const code = SAFE_OPENCODE_FAILURES.has(error?.code) ? error.code : 'opencode-credential-resolution-failed'
      fail(code)
    }
    if (typeof opencodeKey !== 'string' || opencodeKey.length < 1 || Buffer.byteLength(opencodeKey, 'utf8') > 8_192) {
      fail('opencode-approved-key-invalid')
    }
    activeState.github = app
    await saveState(activeState, { ...dependencies, existing: false })
    const adminToken = await loadOrCreateAdminToken(activeState, dependencies)
    return continueProvisioning(activeState, dependencies, credentials, opencodeKey, adminToken)
  }

  const credentials = await loadAppCredentials({ fs: dependencies.fs })
  const remote = await assertAccountAndRemoteState(dependencies, activeState)
  if (remote.worker.exists) {
    if (activeState.phase === 'deploying') fail('deployment-outcome-indeterminate')
    fail('unknown-worker-resource-exists')
  }
  const app = await verifyGitHubAppInstallation(credentials, { fetch: dependencies.fetch, now: dependencies.now })
  activeState.github = app
  const resolveCredential = dependencies.resolveCredential ?? (await import('./opencode-credential.mjs')).resolveApprovedOpenCodeCredential
  let opencodeKey
  try {
    opencodeKey = await resolveCredential()
  } catch (error) {
    const code = SAFE_OPENCODE_FAILURES.has(error?.code) ? error.code : 'opencode-credential-resolution-failed'
    fail(code)
  }
  if (typeof opencodeKey !== 'string' || opencodeKey.length < 1 || Buffer.byteLength(opencodeKey, 'utf8') > 8_192) {
    fail('opencode-approved-key-invalid')
  }
  const adminToken = await loadOrCreateAdminToken(activeState, dependencies)
  await saveState(activeState, { ...dependencies, existing: true })
  return continueProvisioning(activeState, dependencies, credentials, opencodeKey, adminToken)
}

export async function main(argv = process.argv.slice(2), io = console) {
  if (argv.length === 1 && argv[0] === '--help') {
    io.log('Usage: node examples/live-github-flow/deploy-worker.mjs --execute')
    io.log('Provision only the dedicated reviewed test Worker; this command does not register or run a model job.')
    return 0
  }
  if (argv.length !== 1 || argv[0] !== '--execute') {
    io.error('No action taken. Pass --execute only after the independent Sol review and operator approval.')
    return 2
  }
  try {
    const result = await executeLiveWorkerDeployment({ execute: true })
    io.log(JSON.stringify(result))
    return 0
  } catch (error) {
    const code = error instanceof LiveWorkerControllerError ? error.code : 'live-worker-controller-failed'
    io.error(JSON.stringify({ status: 'failed', code, remoteResourcesPreserved: true }))
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main()
}
