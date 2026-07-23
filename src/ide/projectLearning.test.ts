import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import { ProjectLearningLedger } from './projectLearning.js';

describe('ProjectLearningLedger', () => {
  it('stores redacted signals and builds a local profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-learning-'));
    try {
      const ledger = new ProjectLearningLedger(
        new DurableStore(root),
        root,
        () => new Date('2026-07-23T12:00:00.000Z'),
      );
      const signal = await ledger.record({
        kind: 'decision',
        outcome: 'positive',
        fingerprint: 'decision-1',
        summary: 'Use api_key=super-secret in C:\\Users\\alice\\repo',
      });
      expect(signal.redacted).toBe(true);
      expect(signal.summary).not.toContain('super-secret');
      expect(signal.summary).not.toContain('C:\\Users');
      const profile = await ledger.profile();
      expect(profile.localSignals).toBe(1);
      expect(profile.counts.decision).toBe(1);
      expect((await ledger.query('secret')).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
