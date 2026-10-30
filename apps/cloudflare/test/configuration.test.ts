import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import { createWorker } from '../src/worker.js';

const adminToken = 'synthetic-shared-setup-admin-token';
const secretValues = ['synthetic-console-key', 'synthetic-openai-key', 'synthetic-app-private-key', 'synthetic-webhook-secret'];

function fixture() {
  const unused = vi.fn((): never => { throw new Error('Setup status must not access external dependencies'); });
  const worker = createWorker({ storeFor: unused, githubFor: unused, queueFor: unused, targetJobsFor: unused });
  const env: Env = {
    ADMIN_TOKEN: adminToken,
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY: secretValues[2]!,
    GITHUB_WEBHOOK_SECRET: secretValues[3]!,
    OPENCODE_PROVIDER: 'opencode',
    OPENCODE_MODEL: 'test-model',
    OPENCODE_API_KEY: secretValues[0]!,
    OPENAI_API_KEY: secretValues[1]!,
    DB: { prepare: unused, batch: unused },
    JOB_QUEUE: { send: unused },
    TARGET_JOBS: { getByName: unused },
  };
  const fetch = (path = '/admin/configuration', token = adminToken, method = 'GET', body?: unknown) => worker.fetch(new Request(`https://worker.example${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: unused });
  return { env, unused, fetch };
}

describe('shared hosted configuration endpoint', () => {
  it('requires admin authentication before exposing configuration status', async () => {
    const h = fixture();
    const response = await h.fetch('/admin/configuration', 'wrong-token');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(h.unused).not.toHaveBeenCalled();
  });

  it('reports service-scoped readiness without revealing secrets or contacting dependencies', async () => {
    const h = fixture();
    const response = await h.fetch();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      provider: { credentialScope: 'service', provider: 'opencode', model: 'test-model', configured: true },
      github: { credentialScope: 'service', appId: '12345', privateKeyConfigured: true, webhookSecretConfigured: true },
    });
    for (const secret of [adminToken, ...secretValues]) expect(text).not.toContain(secret);
    expect(h.unused).not.toHaveBeenCalled();
  });

  it('reports only the selected missing provider key and reflects updated service bindings', async () => {
    const h = fixture();
    h.env.OPENCODE_PROVIDER = 'openai';
    delete h.env.OPENAI_API_KEY;
    let response = await h.fetch();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: {
      credentialScope: 'service', provider: 'openai', configured: false,
      errorCode: 'agent-provider-credential-missing', requiredKey: 'OPENAI_API_KEY',
    } });
    h.env.OPENAI_API_KEY = 'synthetic-replacement-key';
    response = await h.fetch();
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ provider: { configured: true, provider: 'openai' } });
    expect(text).not.toContain('synthetic-replacement-key');
    expect(h.unused).not.toHaveBeenCalled();
  });

  it('returns a useful incomplete status while keeping unrecognized configuration private', async () => {
    const h = fixture();
    delete h.env.OPENCODE_MODEL;
    h.env.OPENCODE_PROVIDER = 'invalid-private-provider';
    h.env.GITHUB_APP_ID = 'invalid-private-app-id';
    h.env.GITHUB_PRIVATE_KEY = '';
    h.env.GITHUB_WEBHOOK_SECRET = '';
    const response = await h.fetch();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      provider: { provider: null, configured: false },
      github: { appId: null, privateKeyConfigured: false, webhookSecretConfigured: false },
    });
    expect(text).not.toContain('invalid-private');
    expect(h.unused).not.toHaveBeenCalled();
  });

  it('rejects credentials embedded in repository registration instead of persisting them', async () => {
    const h = fixture();
    const response = await h.fetch('/admin/registrations', adminToken, 'POST', {
      installationId: 8, target: { owner: 'account', name: 'repo' }, baseBranch: 'main',
      upstream: {}, policy: {}, apiKey: 'synthetic-per-repo-secret',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid-registration' });
    expect(h.unused).not.toHaveBeenCalled();
  });
});
