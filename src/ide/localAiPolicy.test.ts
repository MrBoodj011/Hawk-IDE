import { describe, expect, it } from 'vitest';
import {
  localAiModelOptions,
  ollamaRuntimeCandidates,
  ollamaRuntimeEnvironment,
  recommendLocalAiModel,
  validateOllamaReleaseAsset,
} from '../../extensions/hawk-security-ide/src/localAiPolicy.js';

describe('Hawk local AI policy', () => {
  it('selects a bounded coding model for the available memory', () => {
    expect(recommendLocalAiModel(8 * 1024 ** 3).model).toBe('qwen2.5-coder:3b');
    expect(recommendLocalAiModel(16 * 1024 ** 3).model).toBe('qwen2.5-coder:7b');
    expect(recommendLocalAiModel(32 * 1024 ** 3).model).toBe('qwen2.5-coder:14b');
    expect(recommendLocalAiModel(64 * 1024 ** 3).model).toBe('qwen2.5-coder:32b');
    expect(localAiModelOptions()).toHaveLength(4);
  });

  it('accepts only a digested standalone runtime from the official Ollama release path', () => {
    expect(
      validateOllamaReleaseAsset({
        name: 'ollama-windows-amd64.zip',
        size: 1_426_451_968,
        browser_download_url:
          'https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-windows-amd64.zip',
        digest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toMatchObject({
      name: 'ollama-windows-amd64.zip',
      sha256: 'a'.repeat(64),
    });
    expect(() =>
      validateOllamaReleaseAsset({
        name: 'ollama-windows-amd64.zip',
        size: 1_426_451_968,
        browser_download_url: 'https://example.com/ollama-windows-amd64.zip',
        digest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(/official GitHub/);
    expect(() =>
      validateOllamaReleaseAsset({
        name: 'ollama-windows-amd64.zip',
        size: 1_426_451_968,
        browser_download_url:
          'https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-windows-amd64.zip',
      }),
    ).toThrow(/SHA-256/);
  });

  it('prefers the Hawk-embedded runtime and isolates model storage', () => {
    const candidates = ollamaRuntimeCandidates({
      executablePath: 'C:\\Program Files\\Hawk\\Hawk.exe',
      extensionRoot: 'C:\\Program Files\\Hawk\\resources\\app\\extensions\\hawk-security-ide',
      globalStorageRoot: 'C:\\Users\\demo\\AppData\\Roaming\\Hawk',
      environment: {
        LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        PATH: 'C:\\Tools',
      },
    });
    expect(candidates[0]).toEqual({
      path: 'C:\\Program Files\\Hawk\\resources\\hawk-local-ai\\ollama\\ollama.exe',
      source: 'embedded',
    });
    expect(candidates.map((candidate) => candidate.source)).toEqual([
      'embedded',
      'embedded',
      'managed',
      'external',
      'external',
      'external',
      'external',
    ]);
    expect(
      ollamaRuntimeEnvironment(
        { PATH: 'C:\\Windows' },
        'C:\\Users\\demo\\AppData\\Local\\Hawk\\models',
      ),
    ).toMatchObject({
      OLLAMA_HOST: '127.0.0.1:11434',
      OLLAMA_MODELS: 'C:\\Users\\demo\\AppData\\Local\\Hawk\\models',
      OLLAMA_NOHISTORY: '1',
    });
  });
});
