import { describe, expect, it } from 'vitest';
import {
  localAiModelOptions,
  recommendLocalAiModel,
  validateOllamaReleaseAsset,
} from '../../extensions/pentesterflow-ide/src/localAiPolicy.js';

describe('Hawk local AI policy', () => {
  it('selects a bounded coding model for the available memory', () => {
    expect(recommendLocalAiModel(8 * 1024 ** 3).model).toBe('qwen2.5-coder:3b');
    expect(recommendLocalAiModel(16 * 1024 ** 3).model).toBe('qwen2.5-coder:7b');
    expect(recommendLocalAiModel(32 * 1024 ** 3).model).toBe('qwen2.5-coder:14b');
    expect(recommendLocalAiModel(64 * 1024 ** 3).model).toBe('qwen2.5-coder:32b');
    expect(localAiModelOptions()).toHaveLength(4);
  });

  it('accepts only a digested installer from the official Ollama release path', () => {
    expect(
      validateOllamaReleaseAsset({
        name: 'OllamaSetup.exe',
        size: 1_426_451_968,
        browser_download_url:
          'https://github.com/ollama/ollama/releases/download/v0.32.1/OllamaSetup.exe',
        digest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toMatchObject({
      name: 'OllamaSetup.exe',
      sha256: 'a'.repeat(64),
    });
    expect(() =>
      validateOllamaReleaseAsset({
        name: 'OllamaSetup.exe',
        size: 1_426_451_968,
        browser_download_url: 'https://example.com/OllamaSetup.exe',
        digest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(/official GitHub/);
    expect(() =>
      validateOllamaReleaseAsset({
        name: 'OllamaSetup.exe',
        size: 1_426_451_968,
        browser_download_url:
          'https://github.com/ollama/ollama/releases/download/v0.32.1/OllamaSetup.exe',
      }),
    ).toThrow(/SHA-256/);
  });
});
