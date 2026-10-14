import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const runtimeTestBindings = {
  ADMIN_TOKEN: 'test-only-admin-token',
  GITHUB_APP_ID: '12345',
  GITHUB_PRIVATE_KEY: 'test-only-not-a-private-key',
  GITHUB_WEBHOOK_SECRET: 'test-only-webhook-value',
  OPENCODE_PROVIDER: 'opencode',
  OPENCODE_API_KEY: 'test-only-not-a-console-key',
  OPENAI_API_KEY: 'test-only-not-an-openai-key',
  OPENCODE_MODEL: 'gpt-6-luna',
};

// Prevent Wrangler from inheriting an operator's real credentials in a test process.
Object.assign(process.env, runtimeTestBindings);

const workerd = cloudflareTest({
  wrangler: { configPath: './wrangler.jsonc' },
  miniflare: { bindings: runtimeTestBindings },
});

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/runtime.test.ts'],
          clearMocks: true,
          restoreMocks: true,
        },
      },
      {
        extends: false,
        plugins: [workerd],
        test: {
          name: 'workerd',
          include: ['test/runtime.test.ts'],
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
