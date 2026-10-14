import { exports, env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurableSqliteJobStore } from '../src/job.js';
import type { NewJobRecord } from '../src/contracts.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sdkSessions(instance: unknown): Record<string, unknown> {
  const agent: unknown = isRecord(instance) ? Reflect.get(instance, 'agent') : undefined;
  const host: unknown = isRecord(agent) ? Reflect.get(agent, 'host') : undefined;
  const sessions: unknown = isRecord(host) ? Reflect.get(host, 'sessions') : undefined;
  if (!isRecord(sessions) || typeof sessions.create !== 'function' || typeof sessions.get !== 'function') {
    throw new Error('OpenCode Workerd session API was not initialized');
  }
  return sessions;
}

async function closeSdkHost(instance: unknown): Promise<void> {
  const agent: unknown = isRecord(instance) ? Reflect.get(instance, 'agent') : undefined;
  const close: unknown = isRecord(agent) ? Reflect.get(agent, 'close') : undefined;
  if (typeof close !== 'function') throw new Error('OpenCode Workerd host close API was not initialized');
  await Reflect.apply(close, agent, []);
}

async function callSdk(sessions: Record<string, unknown>, methodName: 'create' | 'get', input: unknown): Promise<unknown> {
  const method = sessions[methodName];
  if (typeof method !== 'function') throw new Error(`OpenCode session ${methodName} API is unavailable`);
  return Reflect.apply(method, sessions, [input]);
}

function newJob(): NewJobRecord {
  const plan = {
    trackingId: 'runtime-smoke-tracking',
    installationId: 1,
    target: { owner: 'example', name: 'target', fullName: 'example/target' },
    baseBranch: 'main',
    targetBaseCommit: 'a'.repeat(40),
    upstreamRepository: 'https://github.com/example/upstream.git',
    upstreamRef: 'main',
    fromCommit: 'b'.repeat(40),
    expectedLastCheckedCommit: 'b'.repeat(40),
    toCommit: 'c'.repeat(40),
    commitCount: 1,
    changedFiles: [{ path: 'src/example.ts', status: 'modified' as const }],
    changedPaths: ['src/example.ts'],
    checkedChangedPaths: ['src/example.ts'],
    observedAt: '2026-10-09T00:00:00.000Z',
    jobId: 'runtime-smoke-job',
    jobKey: 'runtime-smoke-job-key',
    policyHash: 'd'.repeat(64),
    selectedUpstreamPaths: ['src/example.ts'],
    checkedSelectedUpstreamPaths: ['src/example.ts'],
    selectedSelectionIds: ['example'],
  };
  return { id: plan.jobId, key: plan.jobKey, trackingId: plan.trackingId, stepsUsed: 0, plan };
}

describe('Cloudflare Workerd runtime', () => {
  it('serves the health route from the actual Worker entrypoint', async () => {
    const response = await exports.default.fetch('https://worker.test/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('initializes the real DO and SDK, then recovers their SQLite records after eviction', async () => {
    const stub = env.TARGET_JOBS.getByName(`runtime-smoke-${crypto.randomUUID()}`);
    let sessionID = '';

    await runInDurableObject(stub, async (instance, state) => {
      const prototype = Object.getPrototypeOf(instance);
      const constructor: unknown = Reflect.get(prototype, 'constructor');
      expect(typeof constructor === 'function' && constructor.name).toBe('TargetJobDO');

      const tables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).toArray().map(row => row.name);
      expect(tables).toContain('ocpa_job_records');
      expect(tables).toContain('event');

      const sessions = sdkSessions(instance);
      const created: unknown = await callSdk(sessions, 'create', {
        title: 'Local Workerd persistence smoke',
        agent: 'ocpa-job',
        model: { providerID: 'ocpa-opencode', id: 'gpt-6-luna' },
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'ocpa-job', resource: '*', effect: 'allow' },
        ],
      });
      if (!isRecord(created) || typeof created.id !== 'string') throw new Error('OpenCode did not persist the test session');
      sessionID = created.id;

      const jobs = new DurableSqliteJobStore(state.storage);
      const saved = await jobs.createOrGetJob(newJob());
      expect(saved.created).toBe(true);
      expect(saved.job.status).toBe('queued');

      // The local eviction helper requires an idle actor. Closing the real SDK
      // host leaves its SQLite session intact for the reconstructed instance.
      await closeSdkHost(instance);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const prototype = Object.getPrototypeOf(instance);
      const constructor: unknown = Reflect.get(prototype, 'constructor');
      expect(typeof constructor === 'function' && constructor.name).toBe('TargetJobDO');

      const recoveredSession: unknown = await callSdk(sdkSessions(instance), 'get', { sessionID });
      expect(isRecord(recoveredSession) && recoveredSession.id === sessionID).toBe(true);
      const recoveredModel = isRecord(recoveredSession) ? Reflect.get(recoveredSession, 'model') : undefined;
      expect(recoveredModel).toMatchObject({ providerID: 'ocpa-opencode', id: 'gpt-6-luna' });

      const recoveredJob = await new DurableSqliteJobStore(state.storage).getJob('runtime-smoke-job');
      expect(recoveredJob?.status).toBe('queued');
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });
  });

});
