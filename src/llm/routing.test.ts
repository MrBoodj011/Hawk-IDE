import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/config.js';
import { createRoutedClient, purposeForTask } from './routing.js';

describe('Hawk model routing', () => {
  it('classifies security and reasoning work without routing ordinary edits away', () => {
    expect(purposeForTask('audit the authorization boundary for injection')).toBe('security');
    expect(purposeForTask('diagnose the root cause and redesign the cache')).toBe('reasoning');
    expect(purposeForTask('rename this variable')).toBe('general');
  });

  it('keeps routes without configured credentials dormant', () => {
    const client = createRoutedClient({
      ...defaultConfig(),
      backend: 'ollama',
      model: 'qwen-local',
      fallback_models: [
        {
          name: 'hosted',
          backend: 'openai',
          model: 'gpt-example',
          base_url: '',
          api_key_env: 'HAWK_TEST_MISSING_KEY',
          purpose: 'reasoning',
        },
      ],
    });

    expect(client.name()).toBe('ollama');
    expect(client.model()).toBe('qwen-local');
  });
});
