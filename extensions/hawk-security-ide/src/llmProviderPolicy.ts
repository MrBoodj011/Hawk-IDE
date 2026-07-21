export const HAWK_LLM_SECRET_PREFIX = 'hawk.llm.apiKey.';

export type HawkLlmProviderId =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'deepseek'
  | 'kimi'
  | 'openai-compat';

export interface HawkLlmProviderOption {
  id: HawkLlmProviderId;
  label: string;
  detail: string;
  local: boolean;
  apiKeyRequired: boolean;
  defaultBaseUrl: string;
}

const PROVIDERS: readonly HawkLlmProviderOption[] = [
  {
    id: 'ollama',
    label: 'Ollama - local',
    detail: 'Private local models managed by Hawk; no API key.',
    local: true,
    apiKeyRequired: false,
    defaultBaseUrl: 'http://127.0.0.1:11434',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio - local',
    detail: 'OpenAI-compatible local server; no API key.',
    local: true,
    apiKeyRequired: false,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'Bring your own OpenAI API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    detail: 'Bring your own Anthropic API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    detail: 'Bring your own Gemini API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'Bring your own OpenRouter API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'groq',
    label: 'Groq',
    detail: 'Bring your own Groq API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    detail: 'Bring your own DeepSeek API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    detail: 'Bring your own Moonshot API key.',
    local: false,
    apiKeyRequired: true,
    defaultBaseUrl: '',
  },
  {
    id: 'openai-compat',
    label: 'OpenAI-compatible endpoint',
    detail: 'Custom HTTPS or loopback endpoint; API key is optional.',
    local: false,
    apiKeyRequired: false,
    defaultBaseUrl: '',
  },
] as const;

export function hawkLlmProviders(): readonly HawkLlmProviderOption[] {
  return PROVIDERS;
}

export function hawkLlmProvider(id: string): HawkLlmProviderOption | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function llmSecretStorageKey(provider: string): string {
  if (!hawkLlmProvider(provider)) throw new Error(`Unsupported Hawk LLM provider: ${provider}`);
  return `${HAWK_LLM_SECRET_PREFIX}${provider}`;
}

export function validateProviderBaseUrl(provider: HawkLlmProviderOption, value: string): string {
  const candidate = value.trim();
  if (!candidate) {
    if (provider.id === 'openai-compat') {
      throw new Error('An OpenAI-compatible provider requires a base URL.');
    }
    return '';
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('The provider base URL is invalid.');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials inside a provider URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (provider.local && !loopback) {
    throw new Error('Local provider URLs must use localhost or a loopback address.');
  }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Remote provider URLs must use HTTPS; HTTP is allowed only on loopback.');
  }
  return url.toString().replace(/\/$/, '');
}
