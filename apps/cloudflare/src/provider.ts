export const OPENCODE_PROVIDER_ID = 'ocpa-opencode' as const;
export const OPENAI_PROVIDER_ID = 'ocpa-openai' as const;

export const OPENCODE_CONSOLE_BASE_URL = 'https://opencode.ai/zen/v1' as const;
export const OPENAI_BASE_URL = 'https://api.openai.com/v1' as const;

export type HostedProviderMode = 'opencode' | 'openai';

/** One operator-managed Worker binding set, shared by every registered target. */
export interface HostedProviderEnvironment {
  /** Missing selects OpenCode Console; invalid values never fall back. */
  OPENCODE_PROVIDER?: string;
  OPENCODE_MODEL?: string;
  OPENCODE_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

interface HostedProviderBase {
  apiKey: string;
  model: string;
}

export interface OpenCodeConsoleProvider extends HostedProviderBase {
  provider: 'opencode';
  providerID: typeof OPENCODE_PROVIDER_ID;
  packageName: '@opencode/ai/providers/openai-compatible-responses';
  protocol: 'responses';
  baseURL: typeof OPENCODE_CONSOLE_BASE_URL;
  endpointPath: '/zen/v1/responses';
}

export interface LegacyOpenAIProvider extends HostedProviderBase {
  provider: 'openai';
  providerID: typeof OPENAI_PROVIDER_ID;
  packageName: '@opencode/ai/providers/openai-compatible';
  protocol: 'chat-completions';
  baseURL: typeof OPENAI_BASE_URL;
  endpointPath: '/v1/chat/completions';
}

/** A selected provider is resolved together with exactly its own credential and protocol. */
export type HostedProviderSettings = OpenCodeConsoleProvider | LegacyOpenAIProvider;

export type ProviderSelectionErrorCode =
  | 'agent-provider-invalid'
  | 'agent-model-invalid'
  | 'agent-provider-credential-missing';

export class ProviderSelectionError extends Error {
  constructor(readonly code: ProviderSelectionErrorCode) {
    super(code);
    this.name = 'ProviderSelectionError';
  }
}

export interface ProviderSelectionInput {
  /** Missing means the trusted default, OpenCode Console. Empty/unknown values fail closed. */
  provider?: string;
  model?: string;
  opencodeApiKey?: string;
  openAiApiKey?: string;
}

const OPEN_CODE_PACKAGE = '@opencode/ai/providers/openai-compatible-responses';
const OPENAI_PACKAGE = '@opencode/ai/providers/openai-compatible';
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_API_KEY_BYTES = 8_192;

function validApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_API_KEY_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_PATTERN.test(value);
}

export function resolveHostedProvider(input: ProviderSelectionInput): HostedProviderSettings {
  if (!validModel(input.model)) throw new ProviderSelectionError('agent-model-invalid');

  const provider = input.provider ?? 'opencode';
  if (provider === 'opencode') {
    if (!validApiKey(input.opencodeApiKey)) {
      throw new ProviderSelectionError('agent-provider-credential-missing');
    }
    return {
      provider,
      providerID: OPENCODE_PROVIDER_ID,
      packageName: OPEN_CODE_PACKAGE,
      protocol: 'responses',
      baseURL: OPENCODE_CONSOLE_BASE_URL,
      endpointPath: '/zen/v1/responses',
      apiKey: input.opencodeApiKey,
      model: input.model,
    };
  }

  if (provider === 'openai') {
    if (!validApiKey(input.openAiApiKey)) {
      throw new ProviderSelectionError('agent-provider-credential-missing');
    }
    return {
      provider,
      providerID: OPENAI_PROVIDER_ID,
      packageName: OPENAI_PACKAGE,
      protocol: 'chat-completions',
      baseURL: OPENAI_BASE_URL,
      endpointPath: '/v1/chat/completions',
      apiKey: input.openAiApiKey,
      model: input.model,
    };
  }

  throw new ProviderSelectionError('agent-provider-invalid');
}

/** Resolve directly from service bindings, never from a registration or job record. */
export function resolveHostedProviderEnvironment(env: HostedProviderEnvironment): HostedProviderSettings {
  return resolveHostedProvider({
    ...(env.OPENCODE_PROVIDER !== undefined ? { provider: env.OPENCODE_PROVIDER } : {}),
    ...(env.OPENCODE_MODEL !== undefined ? { model: env.OPENCODE_MODEL } : {}),
    ...(env.OPENCODE_API_KEY !== undefined ? { opencodeApiKey: env.OPENCODE_API_KEY } : {}),
    ...(env.OPENAI_API_KEY !== undefined ? { openAiApiKey: env.OPENAI_API_KEY } : {}),
  });
}

export interface HostedProviderStatus {
  credentialScope: 'service';
  provider: HostedProviderMode | null;
  model?: string;
  configured: boolean;
  errorCode?: ProviderSelectionErrorCode;
  requiredKey?: 'OPENCODE_API_KEY' | 'OPENAI_API_KEY';
}

/** Secret-free local readiness check; performs exactly the validation used by jobs. */
export function hostedProviderStatus(env: HostedProviderEnvironment): HostedProviderStatus {
  const selected = env.OPENCODE_PROVIDER ?? 'opencode';
  const provider = selected === 'opencode' || selected === 'openai' ? selected : null;
  const status: HostedProviderStatus = {
    credentialScope: 'service',
    provider,
    ...(provider !== null && validModel(env.OPENCODE_MODEL) ? { model: env.OPENCODE_MODEL } : {}),
    configured: false,
  };
  try {
    resolveHostedProviderEnvironment(env);
    return { ...status, configured: true };
  } catch (error) {
    if (!(error instanceof ProviderSelectionError)) throw error;
    return {
      ...status,
      errorCode: error.code,
      ...(error.code === 'agent-provider-credential-missing' && provider !== null
        ? { requiredKey: provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENAI_API_KEY' }
        : {}),
    };
  }
}

/** Runtime validation prevents an untrusted or stale provider object from changing route details. */
export function isTrustedHostedProvider(value: unknown): value is HostedProviderSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const provider = value as Partial<HostedProviderSettings>;
  if (!validApiKey(provider.apiKey) || !validModel(provider.model)) return false;
  if (provider.provider === 'opencode') {
    return provider.providerID === OPENCODE_PROVIDER_ID
      && provider.packageName === OPEN_CODE_PACKAGE
      && provider.protocol === 'responses'
      && provider.baseURL === OPENCODE_CONSOLE_BASE_URL
      && provider.endpointPath === '/zen/v1/responses';
  }
  if (provider.provider === 'openai') {
    return provider.providerID === OPENAI_PROVIDER_ID
      && provider.packageName === OPENAI_PACKAGE
      && provider.protocol === 'chat-completions'
      && provider.baseURL === OPENAI_BASE_URL
      && provider.endpointPath === '/v1/chat/completions';
  }
  return false;
}

export function providerModelMatches(
  provider: HostedProviderSettings,
  model: { providerID: string; id: string },
): boolean {
  return model.providerID === provider.providerID && model.id === provider.model;
}

export function providerEndpointMatches(provider: HostedProviderSettings, value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  const base = new URL(provider.baseURL);
  return url.protocol === 'https:'
    && url.origin === base.origin
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.pathname === provider.endpointPath
    && url.search === ''
    && url.hash === '';
}

export function providerResponseMatches(provider: HostedProviderSettings, response: Response): boolean {
  return !response.redirected && (!response.url || providerEndpointMatches(provider, response.url));
}
