import { describe, expect, it } from 'vitest';
import { runAutomaticDebugFixLoop, type DebugFixLoopDriver } from './debugFixLoop';
import type { AiSessionSummary } from './types';

describe('runAutomaticDebugFixLoop', () => {
  it('automatically retries a failed gate and stops on a passing patch', async () => {
    let session = makeSession('running');
    let tests = 0;
    let retries = 0;
    const driver: DebugFixLoopDriver = {
      async getSession() {
        session = { ...session, status: 'awaiting-review' };
        return session;
      },
      async runTests() {
        tests += 1;
        session = {
          ...session,
          status: 'awaiting-review',
          testResults: [
            {
              gateId: 'npm:test',
              label: 'Tests',
              status: tests === 1 ? 'failed' : 'passed',
              exitCode: tests === 1 ? 1 : 0,
              durationMs: 10,
              output: tests === 1 ? 'expected 2, received 1' : 'ok',
            },
          ],
        };
        return session;
      },
      async continueSession() {
        retries += 1;
        session = { ...session, status: 'running', testResults: [] };
        return session;
      },
    };

    const result = await runAutomaticDebugFixLoop({
      session,
      maxAttempts: 3,
      pollIntervalMs: 1,
      driver,
      async buildRetry() {
        return { prompt: 'repair the failing test', context: 'failure evidence' };
      },
    });

    expect(result).toMatchObject({ outcome: 'passed', attempts: 2 });
    expect(tests).toBe(2);
    expect(retries).toBe(1);
  });

  it('stops at the configured attempt bound and never applies changes', async () => {
    let session = makeSession('awaiting-review');
    let retries = 0;
    const driver: DebugFixLoopDriver = {
      async getSession() {
        return session;
      },
      async runTests() {
        session = {
          ...session,
          status: 'awaiting-review',
          testResults: [
            {
              gateId: 'npm:test',
              label: 'Tests',
              status: 'failed',
              exitCode: 1,
              durationMs: 10,
              output: 'still failing',
            },
          ],
        };
        return session;
      },
      async continueSession() {
        retries += 1;
        session = { ...session, status: 'awaiting-review', testResults: [] };
        return session;
      },
    };

    const result = await runAutomaticDebugFixLoop({
      session,
      maxAttempts: 2,
      driver,
      async buildRetry() {
        return { prompt: 'retry', context: 'failure' };
      },
    });

    expect(result).toMatchObject({ outcome: 'exhausted', attempts: 2 });
    expect(result.session.status).toBe('awaiting-review');
    expect(retries).toBe(1);
  });
});

function makeSession(status: AiSessionSummary['status']): AiSessionSummary {
  return {
    id: 'debug-session',
    title: 'Debug failure',
    prompt: 'fix it',
    status,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    background: false,
    autoResume: false,
    resumeCount: 0,
    autoVerify: false,
    maxAutoFixAttempts: 0,
    autoFixAttempt: 0,
    verificationHistory: [],
    checkpoints: [],
    testGates: [
      {
        id: 'npm:test',
        label: 'Tests',
        command: 'npm',
        args: ['test'],
      },
    ],
    testResults: [],
    canApply: false,
    canReject: true,
    canRevert: false,
    canCheckpoint: false,
    canPause: status === 'running',
    canResume: false,
    canOpenTerminal: false,
  };
}
