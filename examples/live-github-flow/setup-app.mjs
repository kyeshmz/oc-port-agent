import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LOOPBACK = '127.0.0.1'
const DEFAULT_PORT = 8807
const CALLBACK_PATH = '/callback'
const API_URL = 'https://api.github.com/app-manifests/'
const PRIVATE_DIR = fileURLToPath(new URL('./.private/', import.meta.url))
const CREDENTIALS_NAME = 'credentials.json'
const MAX_REQUEST_BYTES = 8192
const MAX_PROVIDER_KEY_BYTES = 4096
const MAX_API_RESPONSE_BYTES = 32768
const MAX_PRIVATE_KEY_BYTES = 16384
const API_TIMEOUT_MS = 15000
const APP_NAME = 'oc-port-agent-live-kyeshmz-20261010'
const REPOSITORY_URL = 'https://github.com/kyeshmz/oc-port-agent-live-test-20261010'
const WEBHOOK_URL = 'https://oc-port-agent-live-test-20261010.kye-324.workers.dev/webhooks/github'
const GITHUB_REGISTRATION_URL = 'https://github.com/settings/apps/new'

const PAGE = `
<main>
  <h1>Local GitHub App setup</h1>
  <p>This creates the dedicated test App in your personal GitHub account. Continue only in your normal, authenticated browser.</p>
  <p><strong>Do not install the App yet.</strong> The dedicated backend and webhook endpoint are not deployed. Installation must wait until the backend is ready.</p>
  <p>The App is private and requests only repository contents and pull request write access, plus metadata read access. GitHub will show the final permissions before you approve.</p>
  <form id="github-registration" method="post" action="https://github.com/settings/apps/new">
    <input type="hidden" name="manifest" value="">
    <button type="submit" disabled>Continue to GitHub App registration</button>
  </form>
  <p id="setup-message" role="status">Preparing the fixed test App manifest…</p>
  <p>No App is created until you review and approve it on GitHub.</p>
</main>
<script>
  const form = document.getElementById('github-registration');
  const message = document.getElementById('setup-message');
  fetch('/approval', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('unavailable');
      return response.json();
    })
    .then((approval) => {
      form.action = 'https://github.com/settings/apps/new?state=' + encodeURIComponent(approval.state);
      form.elements.manifest.value = JSON.stringify(approval.manifest);
      form.querySelector('button').disabled = false;
      message.textContent = 'Ready. GitHub will ask you to review and approve this App.';
    })
    .catch(() => {
      message.textContent = 'Setup is unavailable. Do not retry if you already approved an App; check GitHub App settings first.';
    });
</script>`

const COMPLETION_PAGE = `
<main>
  <h1>Local setup status</h1>
  <p id="setup-status" role="status">Loading nonsecret status…</p>
  <p id="install-guidance">Wait for the dedicated backend and webhook endpoint to be ready before installing. When ready, install on <strong>only</strong> the private test repository <code>kyeshmz/oc-port-agent-live-test-20261010</code>.</p>
  <p id="install-container"></p>
  <h2>Optional provider credential</h2>
  <p>The bounded live model run is limited to one attempt, 15 steps, and 180 seconds. A later model run may incur provider charges. No provider call is made by this setup helper.</p>
  <form id="provider-form" method="post" action="/complete" autocomplete="off">
    <input type="hidden" name="csrf" value="">
    <label for="openai-api-key">OpenAI API key (optional)</label>
    <input id="openai-api-key" name="openaiApiKey" type="password" autocomplete="new-password" maxlength="4096" value="">
    <button type="submit">Save locally</button>
  </form>
  <p>The key is sent only to this loopback helper and stored in the protected local credentials file. It is not sent to OpenAI by this page.</p>
</main>
<script>
  const statusLine = document.getElementById('setup-status');
  const providerForm = document.getElementById('provider-form');
  const installContainer = document.getElementById('install-container');
  fetch('/completion-info', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('unavailable');
      return response.json();
    })
    .then((info) => {
      providerForm.elements.csrf.value = info.csrf;
      if (info.registrationFailed) {
        statusLine.textContent = 'The callback did not complete successfully. Do not retry yet; first check GitHub App settings. No GitHub response or credential is displayed here.';
      } else if (info.created) {
        statusLine.textContent = 'App credentials were saved locally. App ID: ' + info.appId + '; slug: ' + info.slug + '. Registration is not installation or backend readiness.';
      } else {
        statusLine.textContent = 'No App credentials have been saved by this helper yet.';
      }
      if (info.installUrl) {
        const link = document.createElement('a');
        link.href = info.installUrl;
        link.textContent = 'Open the App installation page (wait for backend readiness; choose only the test repository)';
        installContainer.append(link);
      }
      if (!info.created) providerForm.hidden = true;
    })
    .catch(() => {
      statusLine.textContent = 'Status is unavailable. No secret values are shown.';
      providerForm.hidden = true;
    });
</script>`

function safeJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  response.end(JSON.stringify(body))
}

function sendHtml(response, status, body) {
  const nonce = randomBytes(18).toString('base64')
  const nonceBody = body.replaceAll('<script>', `<script nonce="${nonce}">`)
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'`,
  })
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live GitHub App setup</title></head><body>${nonceBody}</body></html>`)
}

function sendText(response, status, body = 'Request could not be completed.') {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

function localOrigin(port) {
  return `http://${LOOPBACK}:${port}`
}

function validPort(port) {
  return Number.isInteger(port) && port >= 0 && port <= 65535
}

function hasExactOrigin(request, origin) {
  return request.headers.origin === origin
}

function isSafeSameOriginRead(request, origin) {
  const requestOrigin = request.headers.origin
  const fetchSite = request.headers['sec-fetch-site']
  return (requestOrigin === undefined || requestOrigin === origin) && fetchSite !== 'cross-site'
}

function equalToken(received, expected) {
  if (typeof received !== 'string' || !expected) return false
  const receivedBytes = Buffer.from(received, 'utf8')
  if (receivedBytes.length !== expected.length) return false
  return timingSafeEqual(receivedBytes, expected)
}

function onlyParameter(url, name) {
  const values = url.searchParams.getAll(name)
  return values.length === 1 ? values[0] : null
}

async function initializePrivateStore(privateDir) {
  let createdDirectory = false
  try {
    await mkdir(privateDir, { mode: 0o700 })
    createdDirectory = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('private store unavailable')
  }

  if (createdDirectory) await chmod(privateDir, 0o700).catch(() => {
    throw new Error('private store unavailable')
  })
  const directory = await lstat(privateDir).catch(() => null)
  if (!directory || directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('private store unavailable')
  }
  if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) {
    throw new Error('private store unavailable')
  }
  if ((directory.mode & 0o777) !== 0o700) {
    throw new Error('private store unavailable')
  }

  const credentialsPath = join(privateDir, CREDENTIALS_NAME)
  const existing = await lstat(credentialsPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw new Error('private store unavailable')
  })
  if (existing) {
    // Never inspect or replace a credential file that predates this process.
    throw new Error('private store unavailable')
  }
  return { dev: directory.dev, ino: directory.ino }
}

async function validatePrivateDirectory(privateDir, identity) {
  const directory = await lstat(privateDir).catch(() => null)
  if (!directory || directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700) {
    throw new Error('private store unavailable')
  }
  if (identity && (directory.dev !== identity.dev || directory.ino !== identity.ino)) {
    throw new Error('private store unavailable')
  }
  if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) {
    throw new Error('private store unavailable')
  }
  return { dev: directory.dev, ino: directory.ino }
}

async function validateOwnedCredentialFile(privateDir, identity, directoryIdentity) {
  await validatePrivateDirectory(privateDir, directoryIdentity)
  const filePath = join(privateDir, CREDENTIALS_NAME)
  const file = await lstat(filePath).catch(() => null)
  if (!file || file.isSymbolicLink() || !file.isFile() || (file.mode & 0o777) !== 0o600) {
    throw new Error('private store unavailable')
  }
  if (typeof process.getuid === 'function' && file.uid !== process.getuid()) {
    throw new Error('private store unavailable')
  }
  if (file.nlink !== 1) throw new Error('private store unavailable')
  if (identity && (file.dev !== identity.dev || file.ino !== identity.ino)) {
    throw new Error('private store unavailable')
  }
  return { dev: file.dev, ino: file.ino }
}

async function writeInitialCredentials(privateDir, directoryIdentity, credentials) {
  const filePath = join(privateDir, CREDENTIALS_NAME)
  const tempPath = join(privateDir, `.credentials-${randomBytes(16).toString('hex')}.tmp`)
  let handle
  try {
    await validatePrivateDirectory(privateDir, directoryIdentity)
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(tempPath, 0o600)
    await validatePrivateDirectory(privateDir, directoryIdentity)
    await link(tempPath, filePath)
    await unlink(tempPath)
    return await validateOwnedCredentialFile(privateDir, null, directoryIdentity)
  } catch {
    if (handle) await handle.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw new Error('private store unavailable')
  }
}

async function replaceOwnedCredentials(privateDir, directoryIdentity, identity, credentials) {
  const filePath = join(privateDir, CREDENTIALS_NAME)
  const tempPath = join(privateDir, `.credentials-${randomBytes(16).toString('hex')}.tmp`)
  let handle
  try {
    const currentIdentity = await validateOwnedCredentialFile(privateDir, identity, directoryIdentity)
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(tempPath, 0o600)
    await validateOwnedCredentialFile(privateDir, currentIdentity, directoryIdentity)
    await rename(tempPath, filePath)
    return await validateOwnedCredentialFile(privateDir, null, directoryIdentity)
  } catch {
    if (handle) await handle.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw new Error('private store unavailable')
  }
}

async function readRequestBody(request, limit = MAX_REQUEST_BYTES) {
  const header = request.headers['content-length']
  if (header !== undefined && (!/^\d+$/.test(header) || Number(header) > limit)) {
    throw new Error('request too large')
  }
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) throw new Error('request too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

async function readBoundedResponse(response, maxBytes) {
  const contentLength = response.headers.get('content-length')
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('response too large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('response too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))
}

function validateConversionResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversion response')
  const appId = payload.id
  const slug = payload.slug
  const privateKey = payload.pem
  const webhookSecret = payload.webhook_secret
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('invalid conversion response')
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(slug)) throw new Error('invalid conversion response')
  if (typeof privateKey !== 'string' || Buffer.byteLength(privateKey, 'utf8') > MAX_PRIVATE_KEY_BYTES || !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/.test(privateKey)) {
    throw new Error('invalid conversion response')
  }
  if (typeof webhookSecret !== 'string' || webhookSecret.length < 16 || Buffer.byteLength(webhookSecret, 'utf8') > 2048 || /[\u0000-\u001f\u007f]/.test(webhookSecret)) {
    throw new Error('invalid conversion response')
  }
  return { appId, slug, privateKey, webhookSecret }
}

async function exchangeManifestCode(fetchImpl, code) {
  const response = await fetchImpl(`${API_URL}${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!response || !response.ok) {
    await response?.body?.cancel().catch(() => {})
    throw new Error('GitHub conversion failed')
  }
  const responseText = await readBoundedResponse(response, MAX_API_RESPONSE_BYTES)
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw new Error('invalid conversion response')
  }
  return validateConversionResult(payload)
}

function makePublicStatus(credentials, providerSaved) {
  return {
    appId: credentials?.appId ?? null,
    slug: credentials?.slug ?? null,
    created: credentials !== null,
    missing: {
      appCredentials: credentials === null,
      providerKey: !providerSaved,
      installation: true,
      backendReady: true,
    },
  }
}

function manifestForPort(port) {
  const callbackUrl = `${localOrigin(port)}${CALLBACK_PATH}`
  return {
    name: APP_NAME,
    url: REPOSITORY_URL,
    hook_attributes: {
      url: WEBHOOK_URL,
      active: true,
    },
    redirect_url: callbackUrl,
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    },
    default_events: ['pull_request'],
  }
}

function safeInstallUrl(credentials) {
  if (!credentials) return null
  return `https://github.com/apps/${credentials.slug}/installations/new`
}

export function createSetupServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const privateDir = resolve(options.privateDir ?? PRIVATE_DIR)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (!validPort(port)) throw new TypeError('invalid setup port')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')

  let server
  let actualPort = null
  let privateDirectoryIdentity = null
  let credentials = null
  let credentialsIdentity = null
  let providerSaved = false
  let pendingState = null
  let pendingCsrf = null
  let registrationFailed = false
  let started = false

  const expectedHost = () => `${LOOPBACK}:${actualPort}`
  const expectedOrigin = () => localOrigin(actualPort)

  async function handleCallback(request, response, url) {
    const state = onlyParameter(url, 'state')
    const code = onlyParameter(url, 'code')
    const validState = equalToken(state, pendingState)
    if (!validState) {
      sendText(response, 400)
      return
    }
    pendingState = null

    if ([...url.searchParams.keys()].some((key) => key !== 'state' && key !== 'code') || !code || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
      registrationFailed = true
      sendText(response, 400)
      return
    }

    try {
      const converted = await exchangeManifestCode(fetchImpl, code)
      const nextCredentials = { ...converted }
      credentialsIdentity = await writeInitialCredentials(privateDir, privateDirectoryIdentity, nextCredentials)
      credentials = nextCredentials
      providerSaved = false
      registrationFailed = false
      response.writeHead(303, { Location: '/complete', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      response.end()
    } catch {
      registrationFailed = true
      sendText(response, 502)
    }
  }

  async function handleCompletion(request, response) {
    if (!hasExactOrigin(request, expectedOrigin())) {
      pendingCsrf = null
      sendText(response, 403)
      return
    }
    let body
    try {
      body = await readRequestBody(request)
    } catch {
      pendingCsrf = null
      sendText(response, 413)
      return
    }
    const fields = new URLSearchParams(body.toString('utf8'))
    const csrfValues = fields.getAll('csrf')
    const keyValues = fields.getAll('openaiApiKey')
    const csrf = csrfValues.length === 1 ? csrfValues[0] : null
    const key = keyValues.length === 1 ? keyValues[0] : null
    const validCsrf = equalToken(csrf, pendingCsrf)
    pendingCsrf = null
    if (!validCsrf || fields.size !== csrfValues.length + keyValues.length || keyValues.length > 1) {
      sendText(response, 403)
      return
    }
    if (!credentials || !credentialsIdentity) {
      sendText(response, 409)
      return
    }
    if (key !== null && key !== '') {
      if (/^\s*$/.test(key) || Buffer.byteLength(key, 'utf8') > MAX_PROVIDER_KEY_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(key)) {
        sendText(response, 400)
        return
      }
      try {
        const updatedCredentials = { ...credentials, openaiApiKey: key }
        credentialsIdentity = await replaceOwnedCredentials(privateDir, privateDirectoryIdentity, credentialsIdentity, updatedCredentials)
        credentials = updatedCredentials
        providerSaved = true
      } catch {
        sendText(response, 500)
        return
      }
    }
    response.writeHead(303, { Location: '/complete', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    response.end()
  }

  async function handle(request, response) {
    if (!started || request.headers.host !== expectedHost()) {
      sendText(response, 400)
      return
    }
    if (!request.url || request.url.length > 2048 || !request.url.startsWith('/') || request.url.startsWith('//')) {
      sendText(response, 400)
      return
    }
    let url
    try {
      url = new URL(request.url, expectedOrigin())
    } catch {
      sendText(response, 400)
      return
    }
    if (url.origin !== expectedOrigin()) {
      sendText(response, 400)
      return
    }

    if (request.method === 'GET' && url.pathname === '/') {
      sendHtml(response, 200, PAGE)
      return
    }
    if (request.method === 'GET' && url.pathname === '/approval') {
      if (!isSafeSameOriginRead(request, expectedOrigin())) {
        sendText(response, 403)
        return
      }
      if (registrationFailed || credentials) {
        safeJson(response, 409, { unavailable: true })
        return
      }
      const state = randomBytes(32).toString('base64url')
      pendingState = Buffer.from(state, 'utf8')
      safeJson(response, 200, { state, manifest: manifestForPort(actualPort) })
      return
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      safeJson(response, 200, makePublicStatus(credentials, providerSaved))
      return
    }
    if (request.method === 'GET' && url.pathname === '/complete') {
      sendHtml(response, 200, COMPLETION_PAGE)
      return
    }
    if (request.method === 'GET' && url.pathname === '/completion-info') {
      if (!isSafeSameOriginRead(request, expectedOrigin())) {
        sendText(response, 403)
        return
      }
      const csrf = randomBytes(32).toString('base64url')
      pendingCsrf = Buffer.from(csrf, 'utf8')
      safeJson(response, 200, {
        ...makePublicStatus(credentials, providerSaved),
        csrf,
        installUrl: safeInstallUrl(credentials),
        registrationFailed,
      })
      return
    }
    if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
      await handleCallback(request, response, url)
      return
    }
    if (request.method === 'POST' && url.pathname === '/complete') {
      if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        pendingCsrf = null
        sendText(response, 415)
        return
      }
      await handleCompletion(request, response)
      return
    }
    sendText(response, 404)
  }

  return {
    async start() {
      if (started) throw new Error('setup server already started')
      privateDirectoryIdentity = await initializePrivateStore(privateDir)
      server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) sendText(response, 500)
          else response.destroy()
        })
      })
      server.headersTimeout = 10000
      server.requestTimeout = 15000
      server.keepAliveTimeout = 5000
      server.maxHeadersCount = 32
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, LOOPBACK, () => {
          server.removeListener('error', rejectListen)
          resolveListen()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        await this.close()
        throw new Error('setup server unavailable')
      }
      actualPort = address.port
      started = true
      return {
        url: `${localOrigin(actualPort)}/`,
        statusUrl: `${localOrigin(actualPort)}/status`,
        credentialsPath: join(privateDir, CREDENTIALS_NAME),
      }
    },
    async close() {
      if (!server?.listening) return
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
      started = false
    },
  }
}

async function runFromCommandLine() {
  const rawPort = process.env.LIVE_GITHUB_FLOW_PORT ?? String(DEFAULT_PORT)
  if (!/^\d{1,5}$/.test(rawPort)) {
    console.error('Setup helper could not start safely.')
    process.exitCode = 1
    return
  }
  let app
  try {
    app = createSetupServer({ port: Number(rawPort) })
    const info = await app.start()
    console.log(`Listening at ${info.url}`)
    console.log(`Nonsecret status: ${info.statusUrl}`)
    console.log(`Protected credentials file: ${info.credentialsPath}`)
  } catch {
    console.error('Setup helper could not start safely. Check the protected store and selected port.')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runFromCommandLine()
}
