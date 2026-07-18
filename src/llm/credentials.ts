import type { Backend, Config } from '../config/config.js';

const DEFAULT_ENV: Partial<Record<Backend, readonly string[]>> = {
  openai: ['OPENAI_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

export interface ResolvedCredential {
  apiKey: string;
  source: 'config' | 'environment' | 'missing';
  environmentVariable?: string;
}

export function resolveProviderCredential(
  cfg: Pick<Config, 'backend' | 'api_key' | 'api_key_env'>,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  if (cfg.api_key) return { apiKey: cfg.api_key, source: 'config' };
  const candidates = cfg.api_key_env ? [cfg.api_key_env] : [...(DEFAULT_ENV[cfg.backend] ?? [])];
  for (const name of candidates) {
    const value = environment[name]?.trim();
    if (value) return { apiKey: value, source: 'environment', environmentVariable: name };
  }
  return { apiKey: '', source: 'missing' };
}

export function defaultCredentialEnvironment(backend: Backend): string | undefined {
  return DEFAULT_ENV[backend]?.[0];
}
