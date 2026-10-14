import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OpenCodeCredentialError,
  resolveApprovedOpenCodeCredential,
} from './opencode-credential.mjs'

const SYNTHETIC_KEY = 'synthetic-only-opencode-key-not-a-real-credential'
const APPROVED_CONNECTION = Object.freeze({
  type: 'credential',
  id: 'cred_ff5c3340d002t0edkOPNVJLA35',
  method: 'key',
  label: 'default',
})

async function makeTestRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ocpa-opencode-credential-test-'))
  await chmod(root, 0o700)
  return root
}

function makeHarness(options = {}) {
  const calls = []
  let plugin
  const connection = options.connection ?? APPROVED_CONNECTION
  const connections = options.connections ?? [connection]
  const context = {
    integration: {
      get: async input => {
        calls.push(['get', input])
        if (options.integrationID !== undefined) return { data: { id: options.integrationID, connections } }
        return { data: { id: 'opencode', connections } }
      },
        connection: {
        resolve: async input => {
          calls.push(['resolve', input])
          if (options.resolveError) throw new Error(SYNTHETIC_KEY)
          return Object.hasOwn(options, 'credential') ? options.credential : { type: 'key', key: SYNTHETIC_KEY }
        },
      },
    },
  }
  const hostFactory = async config => {
    calls.push(['host', config])
    plugin = config.plugins[0]
    return {
      sessions: {
        create: async input => {
          calls.push(['session-create', input])
          if (options.sessionError) throw new Error(SYNTHETIC_KEY)
          await plugin.setup(context)
          return { id: 'session-synthetic-only' }
        },
        remove: async input => {
          calls.push(['session-remove', input])
          if (options.removeError) throw new Error('synthetic cleanup failure')
        },
      },
      close: async () => {
        calls.push(['close'])
        if (options.closeError) throw new Error('synthetic close failure')
      },
    }
  }
  return { calls, hostFactory, pluginFactory: async definition => definition }
}

test('resolves only the exact approved key metadata through the plugin credential API', async () => {
  const root = await makeTestRoot()
  const harness = makeHarness()
  try {
    const result = await resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness })
    assert.equal(result, SYNTHETIC_KEY)
    assert.deepEqual(harness.calls.filter(([name]) => name === 'get'), [
      ['get', { integrationID: 'opencode' }],
    ])
    assert.deepEqual(harness.calls.filter(([name]) => name === 'resolve'), [
      ['resolve', APPROVED_CONNECTION],
    ])
    const config = harness.calls.find(([name]) => name === 'host')[1]
    assert.equal(config.models.fetch, false)
    assert.equal(config.models.snapshot, true)
    assert.equal(config.config.project, false)
    assert.equal(config.plugins.length, 1)
    assert.equal(harness.calls.filter(([name]) => name === 'session-create').length, 1)
    assert.equal(harness.calls.filter(([name]) => name === 'session-remove').length, 1)
    assert.equal(harness.calls.some(([name]) => name === 'prompt'), false)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a changed credential id, label, method, or integration without resolving anything', async t => {
  for (const [name, connection] of [
    ['id', { ...APPROVED_CONNECTION, id: 'other' }],
    ['label', { ...APPROVED_CONNECTION, label: 'other' }],
    ['method', { ...APPROVED_CONNECTION, method: 'oauth' }],
    ['type', { ...APPROVED_CONNECTION, type: 'env' }],
  ]) {
    await t.test(name, async () => {
      const root = await makeTestRoot()
      const harness = makeHarness({ connection })
      try {
        await assert.rejects(
          resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
          error => error instanceof OpenCodeCredentialError && error.code === 'approved-credential-metadata-mismatch',
        )
        assert.equal(harness.calls.some(([call]) => call === 'resolve'), false)
        assert.deepEqual(await readdir(root), [])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('refuses duplicate approved metadata and mismatched integration identity', async t => {
  for (const [name, options] of [
    ['duplicate', { connections: [APPROVED_CONNECTION, APPROVED_CONNECTION] }],
    ['integration', { integrationID: 'other' }],
  ]) {
    await t.test(name, async () => {
      const root = await makeTestRoot()
      const harness = makeHarness(options)
      try {
        await assert.rejects(
          resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
          error => error instanceof OpenCodeCredentialError
            && error.code === (name === 'integration' ? 'opencode-integration-metadata-invalid' : 'approved-credential-metadata-mismatch'),
        )
        assert.equal(harness.calls.some(([call]) => call === 'resolve'), false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('rejects non-key credential values and cleans up without returning them', async t => {
  for (const [name, credential] of [
    ['oauth', { type: 'oauth', access: SYNTHETIC_KEY }],
    ['empty-key', { type: 'key', key: '' }],
    ['wrong-shape', null],
  ]) {
    await t.test(name, async () => {
      const root = await makeTestRoot()
      const harness = makeHarness({ credential })
      try {
        await assert.rejects(
          resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
          error => error instanceof OpenCodeCredentialError && error.code === 'approved-credential-value-invalid',
        )
        assert.equal(harness.calls.filter(([call]) => call === 'session-remove').length, 0)
        assert.equal(harness.calls.filter(([call]) => call === 'close').length, 1)
        assert.deepEqual(await readdir(root), [])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('does not return the key if session or host cleanup fails', async t => {
  for (const options of [{ removeError: true }, { closeError: true }]) {
    const root = await makeTestRoot()
    const harness = makeHarness(options)
    try {
      await assert.rejects(
        resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
        error => error instanceof OpenCodeCredentialError && error.code === 'opencode-credential-cleanup-failed',
      )
      assert.deepEqual(await readdir(root), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('suppresses SDK exceptions and never includes synthetic key text in safe errors', async () => {
  const root = await makeTestRoot()
  const harness = makeHarness({ resolveError: true })
  try {
    await assert.rejects(
      resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
      error => error instanceof OpenCodeCredentialError
        && error.code === 'opencode-credential-resolution-failed'
        && !error.message.includes(SYNTHETIC_KEY),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects an invalid or writable temporary root before creating the host', async () => {
  const root = await makeTestRoot()
  const harness = makeHarness()
  await chmod(root, 0o777)
  try {
    await assert.rejects(
      resolveApprovedOpenCodeCredential({ tempRoot: root, ...harness }),
      error => error instanceof OpenCodeCredentialError && error.code === 'approved-temp-root-invalid',
    )
    assert.equal(harness.calls.some(([call]) => call === 'host'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
