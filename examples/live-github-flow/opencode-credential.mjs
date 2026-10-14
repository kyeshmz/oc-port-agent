import { mkdtemp, realpath, lstat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APPROVED = Object.freeze({
  integrationID: 'opencode',
  credentialID: 'cred_ff5c3340d002t0edkOPNVJLA35',
  method: 'key',
  label: 'default',
})

const STARTUP_TIMEOUT_MS = 12_000
const OPERATION_TIMEOUT_MS = 8_000
const CLOSE_TIMEOUT_MS = 5_000
const KEY_MAX_BYTES = 8_192
const PLUGIN_ID = 'ocpa-live-approved-credential-resolver'
const SESSION_TITLE = 'Live Worker credential metadata lookup'

export class OpenCodeCredentialError extends Error {
  constructor(code) {
    super(code)
    this.name = 'OpenCodeCredentialError'
    this.code = code
  }
}

function bounded(promise, timeoutMs, code) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OpenCodeCredentialError(code)), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function isCredentialMetadata(connection) {
  return connection !== null && typeof connection === 'object'
    && connection.type === 'credential'
    && connection.id === APPROVED.credentialID
    && connection.method === APPROVED.method
    && connection.label === APPROVED.label
}

async function resolveFromPluginContext(context) {
  let integration
  try {
    integration = await bounded(
      context.integration.get({ integrationID: APPROVED.integrationID }),
      OPERATION_TIMEOUT_MS,
      'opencode-integration-timeout',
    )
  } catch (error) {
    if (error instanceof OpenCodeCredentialError) throw error
    throw new OpenCodeCredentialError('opencode-integration-unavailable')
  }

  const data = integration?.data
  const connections = data?.connections
  if (!data || data.id !== APPROVED.integrationID || !Array.isArray(connections)) {
    throw new OpenCodeCredentialError('opencode-integration-metadata-invalid')
  }
  const matching = connections.filter(isCredentialMetadata)
  if (matching.length !== 1) throw new OpenCodeCredentialError('approved-credential-metadata-mismatch')

  let credential
  try {
    credential = await bounded(
      context.integration.connection.resolve(matching[0]),
      OPERATION_TIMEOUT_MS,
      'opencode-credential-resolution-timeout',
    )
  } catch (error) {
    if (error instanceof OpenCodeCredentialError) throw error
    throw new OpenCodeCredentialError('opencode-credential-resolution-failed')
  }
  if (!credential || credential.type !== 'key' || typeof credential.key !== 'string'
    || credential.key.length < 1 || Buffer.byteLength(credential.key, 'utf8') > KEY_MAX_BYTES
    || /[\u0000-\u001f\u007f]/.test(credential.key)) {
    throw new OpenCodeCredentialError('approved-credential-value-invalid')
  }
  return credential.key
}

async function createOwnedDirectory(root) {
  let canonicalRoot
  try {
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())
      || (rootStat.mode & 0o022) !== 0) {
      throw new OpenCodeCredentialError('approved-temp-root-invalid')
    }
    canonicalRoot = await realpath(root)
  } catch (error) {
    if (error instanceof OpenCodeCredentialError) throw error
    throw new OpenCodeCredentialError('approved-temp-root-unavailable')
  }

  let directory
  try {
    directory = await mkdtemp(join(canonicalRoot, 'opencode-live-credential-'))
    await chmod(directory, 0o700)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || (info.mode & 0o777) !== 0o700
      || resolve(await realpath(directory)) !== resolve(directory)) {
      throw new OpenCodeCredentialError('owned-temp-directory-invalid')
    }
    return directory
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof OpenCodeCredentialError) throw error
    throw new OpenCodeCredentialError('owned-temp-directory-create-failed')
  }
}

async function defaultPluginFactory(definition) {
  const pluginEntry = new URL('../../apps/cloudflare/node_modules/@opencode/plugin/dist/promise/index.js', import.meta.url)
  try {
    const { Plugin } = await import(pluginEntry.href)
    return Plugin.define(definition)
  } catch {
    throw new OpenCodeCredentialError('opencode-plugin-package-unavailable')
  }
}

async function defaultHostFactory(options) {
  const sdkEntry = new URL('../../apps/cloudflare/node_modules/@opencode/sdk/dist/index.js', import.meta.url)
  let OpenCode
  try {
    ({ OpenCode } = await import(sdkEntry.href))
  } catch {
    throw new OpenCodeCredentialError('opencode-sdk-package-unavailable')
  }
  try {
    return await OpenCode.create(options)
  } catch {
    throw new OpenCodeCredentialError('opencode-host-startup-failed')
  }
}

/**
 * Resolve only the operator-approved OpenCode Console key connection.
 * The returned string is intended for the trusted in-process deploy caller only.
 */
export async function resolveApprovedOpenCodeCredential(options = {}) {
  const root = options.tempRoot ?? join(tmpdir(), 'opencode')
  const hostFactory = options.hostFactory ?? defaultHostFactory
  const pluginFactory = options.pluginFactory ?? defaultPluginFactory
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS
  const log = Object.freeze({ level: 'fatal', emit() {} })

  let directory
  let host
  let hostStartupPromise
  let startupExpired = false
  let sessionID
  let resolvedKey
  let setupPromise
  let cleanupFailed = false

  try {
    directory = await createOwnedDirectory(root)
    const plugin = await pluginFactory({
      id: PLUGIN_ID,
      setup(context) {
        setupPromise = resolveFromPluginContext(context)
        return setupPromise.then(key => {
          resolvedKey = key
        })
      },
    })

    hostStartupPromise = Promise.resolve().then(() => hostFactory({
      plugins: [plugin],
      log,
      models: { fetch: false, snapshot: true },
      config: { directory, project: false },
    }))
    try {
      host = await bounded(hostStartupPromise, startupTimeoutMs, 'opencode-host-startup-timeout')
    } catch (error) {
      if (error instanceof OpenCodeCredentialError && error.code === 'opencode-host-startup-timeout') {
        startupExpired = true
        void hostStartupPromise.then(lateHost => {
          if (lateHost && typeof lateHost.close === 'function') {
            return bounded(lateHost.close(), closeTimeoutMs, 'opencode-host-close-timeout')
          }
        }).catch(() => undefined)
      }
      throw error
    }

    if (!setupPromise) {
      // Plugin setup is location-scoped. This owned, titled session carries no prompt,
      // model selection, attachments, tools, or user data and is removed in cleanup.
      const session = await bounded(host.sessions.create({
        title: SESSION_TITLE,
        location: { directory },
      }), startupTimeoutMs, 'opencode-metadata-session-timeout')
      if (!session || typeof session.id !== 'string' || session.id.length < 1 || session.id.length > 256) {
        throw new OpenCodeCredentialError('opencode-metadata-session-invalid')
      }
      sessionID = session.id
    }

    if (!setupPromise) throw new OpenCodeCredentialError('opencode-plugin-not-activated')
    await bounded(setupPromise, startupTimeoutMs, 'opencode-plugin-setup-timeout')
    if (typeof resolvedKey !== 'string' || resolvedKey.length < 1) {
      throw new OpenCodeCredentialError('approved-credential-not-resolved')
    }
  } catch (error) {
    const code = error instanceof OpenCodeCredentialError ? error.code : 'opencode-credential-setup-failed'
    resolvedKey = undefined
    throw new OpenCodeCredentialError(code)
  } finally {
    if (host && sessionID) {
      try {
        await bounded(host.sessions.remove({ sessionID }), closeTimeoutMs, 'opencode-session-cleanup-timeout')
      } catch {
        cleanupFailed = true
      }
    }
    if (host) {
      try {
        await bounded(host.close(), closeTimeoutMs, 'opencode-host-close-timeout')
      } catch {
        cleanupFailed = true
      }
    }
    if (startupExpired && hostStartupPromise) {
      // A host that settles after the startup budget is closed by the attached
      // continuation above; never keep the approved credential in that host.
      hostStartupPromise.catch(() => undefined)
    }
    if (directory) {
      try {
        const info = await lstat(directory)
        if (info.isDirectory() && !info.isSymbolicLink()
          && (typeof process.getuid !== 'function' || info.uid === process.getuid())) {
          await rm(directory, { recursive: true, force: false })
        } else {
          cleanupFailed = true
        }
      } catch {
        cleanupFailed = true
      }
    }
  }

  if (cleanupFailed) {
    resolvedKey = undefined
    throw new OpenCodeCredentialError('opencode-credential-cleanup-failed')
  }
  return resolvedKey
}
