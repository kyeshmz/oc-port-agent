import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupServer } from './setup-app.mjs'

const SYNTHETIC_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_TEST_KEY_MATERIAL\n-----END PRIVATE KEY-----\n'
const SYNTHETIC_WEBHOOK_SECRET = 'synthetic-webhook-secret-123456'
const SYNTHETIC_CLIENT_SECRET = 'synthetic-client-secret-not-to-save'
const SYNTHETIC_PROVIDER_KEY = 'synthetic-provider-key-never-to-display'
const SYNTHETIC_CODE = 'synthetic-manifest-code-456'
const TEST_APP_SLUG = 'oc-port-agent-live-kyeshmz-20261010'

async function makeWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'live-github-flow-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, privateDir: join(root, '.private') }
}

async function launch(t, options = {}) {
  const workspace = await makeWorkspace(t)
  const helper = createSetupServer({ port: 0, privateDir: workspace.privateDir, ...options })
  const info = await helper.start()
  t.after(() => helper.close())
  return { ...workspace, helper, info, origin: new URL(info.url).origin }
}

async function call(origin, pathname, options = {}) {
  return fetch(`${origin}${pathname}`, options)
}

async function getApproval(origin) {
  const response = await call(origin, '/approval')
  assert.equal(response.status, 200)
  return response.json()
}

async function callback(origin, state, code = SYNTHETIC_CODE, options = {}) {
  return call(origin, `/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, {
    redirect: 'manual',
    ...options,
  })
}

function assertPageScriptsMatchCsp(response, html, expectedCount) {
  const csp = response.headers.get('content-security-policy')
  const cspNonce = csp?.match(/script-src 'nonce-([^']+)'/)?.[1]
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)]
  assert.ok(cspNonce, 'page CSP must include a nonce source')
  assert.doesNotMatch(csp, /'unsafe-inline'/)
  assert.equal(scripts.length, expectedCount)
  assert.ok(scripts.every(([, attributes]) => attributes.match(/\bnonce="([^"]+)"/)?.[1] === cspNonce), 'every inline script nonce must match the CSP nonce')
}

function syntheticSuccessFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({
      id: 73421,
      slug: TEST_APP_SLUG,
      pem: SYNTHETIC_PRIVATE_KEY,
      webhook_secret: SYNTHETIC_WEBHOOK_SECRET,
      client_id: 'synthetic-client-id',
      client_secret: SYNTHETIC_CLIENT_SECRET,
      unused_private_data: 'must-not-be-persisted',
    }), { status: 201, headers: { 'content-type': 'application/json' } })
  }
}

async function requestWithHost(origin, pathname, host) {
  const url = new URL(pathname, origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: Number(url.port),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { Host: host },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end()
  })
}

test('serves the fixed private manifest with loopback callback and narrow permissions', async (t) => {
  const { info, origin } = await launch(t)
  const page = await call(origin, '/')
  const html = await page.text()
  assert.equal(page.status, 200)
  assertPageScriptsMatchCsp(page, html, 1)
  assert.match(html, /Do not install the App yet/)
  assert.match(html, /normal, authenticated browser/)
  assert.doesNotMatch(html, /state=[A-Za-z0-9_-]{20,}/)

  const approval = await getApproval(origin)
  assert.match(approval.state, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(approval.manifest, {
    name: 'oc-port-agent-live-kyeshmz-20261010',
    url: 'https://github.com/kyeshmz/oc-port-agent-live-test-20261010',
    hook_attributes: {
      url: 'https://oc-port-agent-live-test-20261010.kye-324.workers.dev/webhooks/github',
      active: true,
    },
    redirect_url: `${origin}/callback`,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: ['pull_request'],
  })
  assert.equal(info.url, `${origin}/`)
  assert.equal(info.statusUrl, `${origin}/status`)
  assert.match(info.credentialsPath, /\.private[/\\]credentials\.json$/)
})

test('checked-in GitHub App manifest uses only manually subscribable events and least privilege', async () => {
  const manifestPath = new URL('../../apps/cloudflare/github-app-manifest.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(manifest.default_events, ['pull_request'])
  assert.deepEqual(manifest.default_permissions, {
    contents: 'write',
    metadata: 'read',
    pull_requests: 'write',
  })
})

test('exchanges one valid callback, stores only required credentials, and never exposes them', async (t) => {
  const calls = []
  const { privateDir, info, origin } = await launch(t, { fetchImpl: syntheticSuccessFetch(calls) })
  const before = await call(origin, '/status')
  assert.deepEqual(await before.json(), {
    appId: null,
    slug: null,
    created: false,
    missing: { appCredentials: true, providerKey: true, installation: true, backendReady: true },
  })

  const approval = await getApproval(origin)
  const response = await callback(origin, approval.state)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/complete')
  assert.equal(await response.text(), '')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://api.github.com/app-manifests/${SYNTHETIC_CODE}/conversions`)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.redirect, 'error')

  const replay = await callback(origin, approval.state)
  assert.equal(replay.status, 400)
  assert.equal(calls.length, 1)

  const credentials = JSON.parse(await readFile(info.credentialsPath, 'utf8'))
  assert.deepEqual(Object.keys(credentials).sort(), ['appId', 'privateKey', 'slug', 'webhookSecret'])
  assert.equal(credentials.appId, 73421)
  assert.equal(credentials.slug, TEST_APP_SLUG)
  assert.equal(credentials.privateKey, SYNTHETIC_PRIVATE_KEY)
  assert.equal(credentials.webhookSecret, SYNTHETIC_WEBHOOK_SECRET)
  assert.equal(JSON.stringify(credentials).includes(SYNTHETIC_CLIENT_SECRET), false)
  assert.equal(JSON.stringify(credentials).includes('must-not-be-persisted'), false)
  assert.equal((await lstat(privateDir)).mode & 0o777, 0o700)
  assert.equal((await lstat(info.credentialsPath)).mode & 0o777, 0o600)

  const statusResponse = await call(origin, '/status')
  const statusText = await statusResponse.text()
  assert.deepEqual(JSON.parse(statusText), {
    appId: 73421,
    slug: TEST_APP_SLUG,
    created: true,
    missing: { appCredentials: false, providerKey: true, installation: true, backendReady: true },
  })
  for (const secret of [SYNTHETIC_PRIVATE_KEY, SYNTHETIC_WEBHOOK_SECRET, SYNTHETIC_CLIENT_SECRET, SYNTHETIC_CODE]) {
    assert.equal(statusText.includes(secret), false)
  }

  const completion = await call(origin, '/complete')
  const completionHtml = await completion.text()
  assert.equal(completion.status, 200)
  assertPageScriptsMatchCsp(completion, completionHtml, 1)
  assert.match(completionHtml, /Wait for the dedicated backend and webhook endpoint to be ready/)
  assert.match(completionHtml, /only<\/strong> the private test repository/)
  assert.match(completionHtml, /one attempt, 15 steps, and 180 seconds/)
  for (const secret of [SYNTHETIC_PRIVATE_KEY, SYNTHETIC_WEBHOOK_SECRET, SYNTHETIC_CLIENT_SECRET, SYNTHETIC_CODE, approval.state]) {
    assert.equal(completionHtml.includes(secret), false)
  }
})

test('provider key requires same-origin host and one-use CSRF, and is only saved locally', async (t) => {
  const calls = []
  const { info, origin } = await launch(t, { fetchImpl: syntheticSuccessFetch(calls) })
  const approval = await getApproval(origin)
  const appResponse = await callback(origin, approval.state)
  assert.equal(appResponse.status, 303)

  const crossOriginInfo = await call(origin, '/completion-info', { headers: { origin: 'https://attacker.invalid' } })
  assert.equal(crossOriginInfo.status, 403)

  const wrongHost = await requestWithHost(origin, `/callback?state=${approval.state}&code=${SYNTHETIC_CODE}`, 'github.com')
  assert.equal(wrongHost.status, 400)
  assert.equal(wrongHost.body.includes(SYNTHETIC_CODE), false)

  const infoResponse = await call(origin, '/completion-info')
  const completionInfo = await infoResponse.json()
  assert.match(completionInfo.csrf, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(completionInfo.installUrl, `https://github.com/apps/${TEST_APP_SLUG}/installations/new`)
  assert.equal(JSON.stringify(completionInfo).includes(SYNTHETIC_PRIVATE_KEY), false)

  const wrongOrigin = await call(origin, '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://attacker.invalid' },
    body: new URLSearchParams({ csrf: completionInfo.csrf, openaiApiKey: SYNTHETIC_PROVIDER_KEY }),
    redirect: 'manual',
  })
  assert.equal(wrongOrigin.status, 403)

  const freshInfo = await (await call(origin, '/completion-info')).json()
  const badCsrf = await call(origin, '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ csrf: 'wrong-token', openaiApiKey: SYNTHETIC_PROVIDER_KEY }),
    redirect: 'manual',
  })
  assert.equal(badCsrf.status, 403)

  const nextInfo = await (await call(origin, '/completion-info')).json()
  const providerResponse = await call(origin, '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ csrf: nextInfo.csrf, openaiApiKey: SYNTHETIC_PROVIDER_KEY }),
    redirect: 'manual',
  })
  assert.equal(providerResponse.status, 303)
  assert.equal(providerResponse.headers.get('location'), '/complete')
  assert.equal(calls.length, 1, 'saving a provider key must not call the provider')

  const credentials = JSON.parse(await readFile(info.credentialsPath, 'utf8'))
  assert.equal(credentials.openaiApiKey, SYNTHETIC_PROVIDER_KEY)
  assert.deepEqual(Object.keys(credentials).sort(), ['appId', 'openaiApiKey', 'privateKey', 'slug', 'webhookSecret'])
  assert.equal((await lstat(info.credentialsPath)).mode & 0o777, 0o600)
  const statusText = await (await call(origin, '/status')).text()
  assert.equal(statusText.includes(SYNTHETIC_PROVIDER_KEY), false)
  assert.equal(JSON.parse(statusText).missing.providerKey, false)
  assert.equal(JSON.stringify(freshInfo).includes(SYNTHETIC_PROVIDER_KEY), false)
})

test('rejects wrong callback state, duplicate parameters, and hostile hosts without exchanging a code', async (t) => {
  const calls = []
  const { origin } = await launch(t, { fetchImpl: syntheticSuccessFetch(calls) })
  const approval = await getApproval(origin)
  const wrongState = await callback(origin, `${approval.state}x`)
  assert.equal(wrongState.status, 400)

  const crossOriginApproval = await call(origin, '/approval', { headers: { origin: 'https://attacker.invalid' } })
  assert.equal(crossOriginApproval.status, 403)

  const duplicate = await call(origin, `/callback?state=${approval.state}&state=${approval.state}&code=${SYNTHETIC_CODE}`, { redirect: 'manual' })
  assert.equal(duplicate.status, 400)
  assert.equal(calls.length, 0)

  const hostResult = await requestWithHost(origin, `/callback?state=${approval.state}&code=${SYNTHETIC_CODE}`, '127.0.0.1:1')
  assert.equal(hostResult.status, 400)
  assert.equal(calls.length, 0)

  const validCallback = await callback(origin, approval.state)
  assert.equal(validCallback.status, 303)
  assert.equal(calls.length, 1)
})

test('bounds callback response and hides GitHub API error bodies', async (t) => {
  const apiSecretSentinel = 'synthetic-api-response-secret-sentinel'
  const { origin } = await launch(t, {
    fetchImpl: async () => new Response(apiSecretSentinel, { status: 503 }),
  })
  const approval = await getApproval(origin)
  const response = await callback(origin, approval.state)
  const body = await response.text()
  assert.equal(response.status, 502)
  assert.equal(body.includes(apiSecretSentinel), false)

  const info = await (await call(origin, '/completion-info')).json()
  assert.equal(info.created, false)
  assert.equal(info.registrationFailed, true)
  assert.equal(JSON.stringify(info).includes(apiSecretSentinel), false)
  assert.equal((await call(origin, '/approval')).status, 409)
})

test('rejects an oversized successful GitHub conversion response without exposing it', async (t) => {
  const responseSentinel = 'synthetic-oversized-api-response-secret'
  const oversizedResponse = JSON.stringify({
    id: 73421,
    slug: TEST_APP_SLUG,
    pem: SYNTHETIC_PRIVATE_KEY,
    webhook_secret: SYNTHETIC_WEBHOOK_SECRET,
    extra: responseSentinel.repeat(1800),
  })
  const { origin } = await launch(t, {
    fetchImpl: async () => new Response(oversizedResponse, { status: 201 }),
  })
  const approval = await getApproval(origin)
  const response = await callback(origin, approval.state)
  const body = await response.text()
  assert.equal(response.status, 502)
  assert.equal(body.includes(responseSentinel), false)
  assert.deepEqual(JSON.parse(await (await call(origin, '/status')).text()).created, false)
})

test('rejects oversized provider forms before saving', async (t) => {
  const { origin } = await launch(t, { fetchImpl: syntheticSuccessFetch() })
  const approval = await getApproval(origin)
  assert.equal((await callback(origin, approval.state)).status, 303)
  const info = await (await call(origin, '/completion-info')).json()
  const response = await call(origin, '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: `csrf=${info.csrf}&openaiApiKey=${'x'.repeat(9000)}`,
    redirect: 'manual',
  })
  assert.equal(response.status, 413)

  const freshInfo = await (await call(origin, '/completion-info')).json()
  const oversizedKey = await call(origin, '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ csrf: freshInfo.csrf, openaiApiKey: 'k'.repeat(4097) }),
    redirect: 'manual',
  })
  assert.equal(oversizedKey.status, 400)
})

test('fails closed for symlinked or pre-existing credential paths without overwriting them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'live-github-flow-unsafe-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const privateDir = join(root, '.private')
  await mkdir(privateDir, { mode: 0o700 })
  await writeFile(join(privateDir, 'credentials.json'), 'synthetic-pre-existing-file', { mode: 0o600 })
  const existingHelper = createSetupServer({ port: 0, privateDir, fetchImpl: syntheticSuccessFetch() })
  await assert.rejects(existingHelper.start(), /private store unavailable/)
  assert.equal(await readFile(join(privateDir, 'credentials.json'), 'utf8'), 'synthetic-pre-existing-file')

  const target = join(root, 'target')
  const symlinkedStore = join(root, 'symlinked-private')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, symlinkedStore, 'dir')
  const symlinkHelper = createSetupServer({ port: 0, privateDir: symlinkedStore, fetchImpl: syntheticSuccessFetch() })
  await assert.rejects(symlinkHelper.start(), /private store unavailable/)
  assert.deepEqual(await (await import('node:fs/promises')).readdir(target), [])
})

test('status and error responses never contain approval state, code, or synthetic secret material', async (t) => {
  const { origin } = await launch(t, {
    fetchImpl: async () => new Response(JSON.stringify({
      id: 73421,
      slug: TEST_APP_SLUG,
      pem: SYNTHETIC_PRIVATE_KEY,
      webhook_secret: SYNTHETIC_WEBHOOK_SECRET,
      client_secret: SYNTHETIC_CLIENT_SECRET,
    }), { status: 201 }),
  })
  const approval = await getApproval(origin)
  const invalidCode = await callback(origin, approval.state, `${SYNTHETIC_CODE}&client_secret=${SYNTHETIC_CLIENT_SECRET}`)
  const invalidText = await invalidCode.text()
  assert.equal(invalidCode.status, 400)
  for (const value of [approval.state, SYNTHETIC_CODE, SYNTHETIC_PRIVATE_KEY, SYNTHETIC_WEBHOOK_SECRET, SYNTHETIC_CLIENT_SECRET]) {
    assert.equal(invalidText.includes(value), false)
  }
  const statusText = await (await call(origin, '/status')).text()
  for (const value of [approval.state, SYNTHETIC_CODE, SYNTHETIC_PRIVATE_KEY, SYNTHETIC_WEBHOOK_SECRET, SYNTHETIC_CLIENT_SECRET]) {
    assert.equal(statusText.includes(value), false)
  }
})
