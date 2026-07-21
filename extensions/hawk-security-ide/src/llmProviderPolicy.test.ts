import { describe, expect, it } from 'vitest';
import {
  hawkLlmProvider,
  llmSecretStorageKey,
  validateProviderBaseUrl,
} from './llmProviderPolicy';

describe('Hawk LLM provider policy', () => {
  it('builds a provider-specific secret storage key', () => {
    expect(llmSecretStorageKey('openai')).toBe('hawk.llm.apiKey.openai');
    expect(() => llmSecretStorageKey('unknown')).toThrow(/Unsupported/);
  });

  it('allows HTTP only for loopback endpoints', () => {
    const compatible = hawkLlmProvider('openai-compat');
    expect(compatible).toBeDefined();
    expect(validateProviderBaseUrl(compatible!, 'http://127.0.0.1:8080/v1/')).toBe(
      'http://127.0.0.1:8080/v1',
    );
    expect(() => validateProviderBaseUrl(compatible!, 'http://models.example/v1')).toThrow(
      /HTTPS/,
    );
  });

  it('keeps local providers bound to loopback', () => {
    const ollama = hawkLlmProvider('ollama');
    expect(ollama).toBeDefined();
    expect(() => validateProviderBaseUrl(ollama!, 'https://ollama.example')).toThrow(/loopback/);
  });
});
