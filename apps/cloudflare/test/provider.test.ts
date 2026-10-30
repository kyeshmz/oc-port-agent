import { describe, expect, it } from 'vitest';
import {
  hostedProviderStatus,
  resolveHostedProviderEnvironment,
  type HostedProviderEnvironment,
} from '../src/provider.js';

describe('service-owned hosted provider configuration', () => {
  it('reports an incomplete service without throwing or inventing a model', () => {
    expect(hostedProviderStatus({})).toEqual({
      credentialScope: 'service', provider: 'opencode', configured: false, errorCode: 'agent-model-invalid',
    });
  });

  it.each(['opencode', 'openai'] as const)('uses only the selected %s credential and returns secret-free readiness', provider => {
    const env = {
      OPENCODE_PROVIDER: provider, OPENCODE_MODEL: 'test-model',
      OPENCODE_API_KEY: 'synthetic-console-secret', OPENAI_API_KEY: 'synthetic-openai-secret',
    };
    expect(hostedProviderStatus(env)).toEqual({
      credentialScope: 'service', provider, model: 'test-model', configured: true,
    });
    const selectedKey = provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENAI_API_KEY';
    const otherKey = provider === 'opencode' ? 'OPENAI_API_KEY' : 'OPENCODE_API_KEY';
    expect(hostedProviderStatus({ ...env, [otherKey]: '\n invalid unselected key' }).configured).toBe(true);
    for (const key of [undefined, '', ' ', '\t', 'synthetic key', ' key', 'key ', 'key\n', 'key\r', 'key\u0000', 'key\u007f', 'key\u0085', 'key\u00a0', 'x'.repeat(8193)]) {
      const invalid = { ...env, [selectedKey]: key };
      expect(() => resolveHostedProviderEnvironment(invalid)).toThrow('agent-provider-credential-missing');
      expect(hostedProviderStatus(invalid)).toEqual({
        credentialScope: 'service', provider, model: 'test-model', configured: false,
        errorCode: 'agent-provider-credential-missing', requiredKey: selectedKey,
      });
    }
  });

  it.each([
    { OPENCODE_PROVIDER: 'synthetic-secret-provider', OPENCODE_MODEL: 'test-model' },
    { OPENCODE_PROVIDER: '', OPENCODE_MODEL: 'test-model' },
    { OPENCODE_PROVIDER: 'opencode', OPENCODE_MODEL: 'synthetic secret model' },
    { OPENCODE_PROVIDER: 'openai', OPENCODE_MODEL: 'synthetic\nsecret-model' },
  ])('redacts invalid selections and agrees with production validation: %j', env => {
    const input: HostedProviderEnvironment = { ...env, OPENCODE_API_KEY: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-other-secret' };
    const status = hostedProviderStatus(input);
    expect(status.configured).toBe(false);
    expect(() => resolveHostedProviderEnvironment(input)).toThrow(status.errorCode);
    expect(JSON.stringify(status)).not.toContain('synthetic');
    if (env.OPENCODE_PROVIDER !== 'opencode' && env.OPENCODE_PROVIDER !== 'openai') {
      expect(status.provider).toBeNull();
      expect(status.model).toBeUndefined();
    } else {
      expect(status.model).toBeUndefined();
    }
  });
});
