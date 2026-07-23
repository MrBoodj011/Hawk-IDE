import { describe, expect, it } from 'vitest';
import { privacySpeedPosture } from './privacySpeed.js';

describe('privacySpeedPosture', () => {
  it('declares bounded local-first guarantees without exposing endpoint credentials', () => {
    const previous = process.env.HAWK_IDE_LOCAL_ONLY;
    process.env.HAWK_IDE_LOCAL_ONLY = '1';
    try {
      const posture = privacySpeedPosture({
        cache: { enabled: true, ttlMs: 10_000, maxEntries: 64 },
        index: { embeddingsEnabled: false, memoryBudgetBytes: 320 * 1024 * 1024 },
      });
      expect(posture.mode).toBe('local-first');
      expect(posture.localModel.remoteFallback).toBe('disabled');
      expect(posture.localModel.endpoint).toBe('http://127.0.0.1:11434');
      expect(posture.index.incremental).toBe(true);
      expect(posture.redaction.learningSignals).toBe(true);
    } finally {
      if (previous === undefined) process.env.HAWK_IDE_LOCAL_ONLY = undefined;
      else process.env.HAWK_IDE_LOCAL_ONLY = previous;
    }
  });
});
