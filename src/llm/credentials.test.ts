import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/config.js';
import { defaultCredentialEnvironment, resolveProviderCredential } from './credentials.js';

describe('provider credentials', () => {
  it('prefers an explicitly configured key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openai';
    cfg.api_key = 'configured';
    expect(resolveProviderCredential(cfg, { OPENAI_API_KEY: 'environment' })).toEqual({
      apiKey: 'configured',
      source: 'config',
    });
  });

  it('supports environment-only BYOK configuration', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openai';
    const result = resolveProviderCredential(cfg, { OPENAI_API_KEY: 'sk-test' });
    expect(result.apiKey).toBe('sk-test');
    expect(result.source).toBe('environment');
    expect(result.environmentVariable).toBe('OPENAI_API_KEY');
  });

  it('supports a custom environment variable without persisting its value', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openai-compat';
    cfg.api_key_env = 'HAWK_CORPORATE_LLM_KEY';
    expect(resolveProviderCredential(cfg, { HAWK_CORPORATE_LLM_KEY: 'corporate' }).apiKey).toBe(
      'corporate',
    );
  });

  it('documents the default key name for hosted providers', () => {
    expect(defaultCredentialEnvironment('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(defaultCredentialEnvironment('ollama')).toBeUndefined();
  });
});
