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
        { globalStore: new DurableStore(join(root, 'global')) },
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

  it('upgrades reviewed fixes after apply and enforces bounded local and global retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-learning-lifecycle-'));
    try {
      let clock = 0;
      const localStore = new DurableStore(root);
      const globalStore = new DurableStore(join(root, 'global'));
      const ledger = new ProjectLearningLedger(
        localStore,
        root,
        () => new Date(Date.UTC(2026, 6, 23, 12, 0, clock++)),
        { globalStore, maxSignals: 10 },
      );
      const baseSession = {
        id: 'session-1',
        title: 'Fix authorization',
        prompt: 'Fix authorization',
        status: 'awaiting-review',
        createdAt: '2026-07-23T12:00:00.000Z',
        updatedAt: '2026-07-23T12:00:00.000Z',
        background: false,
        autoResume: false,
        resumeCount: 0,
        autoVerify: false,
        maxAutoFixAttempts: 2,
        autoFixAttempt: 0,
        verificationHistory: [],
        checkpoints: [],
        testGates: [],
        testResults: [],
        quality: {
          reproduction: 'passed',
          tests: 'passed',
          semanticReview: 'passed',
        },
        canApply: true,
        canReject: true,
        canRevert: false,
        canCheckpoint: true,
        canPause: false,
        canResume: false,
        canOpenTerminal: true,
      } as const;
      await ledger.recordSession(baseSession);
      await ledger.recordSession({ ...baseSession, status: 'applied' });

      const applied = (
        await localStore.listJson<{ kind: string; outcome: string }>('learning-signals')
      ).find((entry) => entry.kind === 'fix');
      expect(applied?.outcome).toBe('positive');

      for (let index = 0; index < 14; index += 1) {
        await ledger.record({
          kind: 'decision',
          outcome: 'neutral',
          fingerprint: `decision-${index}`,
          summary: `Decision ${index}`,
        });
      }
      expect(await localStore.listJson('learning-signals')).toHaveLength(10);
      expect(await globalStore.listJson('learning-signals')).toHaveLength(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
