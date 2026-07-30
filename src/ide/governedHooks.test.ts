import { describe, expect, it } from 'vitest';
import { evaluateHawkHook } from './governedHooks.js';

describe('governed agent hooks', () => {
  it('blocks destructive commands and never retains raw arguments', () => {
    const result = evaluateHawkHook(
      {
        event: 'preToolUse',
        tool: 'terminal_exec',
        arguments: { command: 'git reset --hard', password: 'do-not-retain' },
        approved: true,
      },
      new Date('2026-07-29T00:00:00.000Z'),
    );
    expect(result).toMatchObject({
      decision: 'deny',
      matchedRules: expect.arrayContaining([
        'hawk-hook-sensitive-tool',
        'hawk-hook-destructive-command',
      ]),
      redactions: ['secret-like argument content'],
      audit: {
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        retainedArguments: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-retain');
  });

  it('requires approval for secret paths and gates edits, failures, and stop events', () => {
    expect(
      evaluateHawkHook({
        event: 'preToolUse',
        tool: 'file_read',
        arguments: { path: '.env' },
      }).decision,
    ).toBe('require-approval');
    expect(
      evaluateHawkHook({
        event: 'postToolUse',
        tool: 'file_edit',
        outcome: 'success',
      }),
    ).toMatchObject({
      decision: 'allow-with-gates',
      requiredGates: expect.arrayContaining(['diff review', 'tests']),
    });
    expect(evaluateHawkHook({ event: 'errorOccurred', error: 'crash' }).requiredGates).toContain(
      'checkpoint preservation',
    );
    expect(evaluateHawkHook({ event: 'subagentStop' }).requiredGates).toContain(
      'unfinished task detection',
    );
    expect(evaluateHawkHook({ event: 'sessionStart' }).decision).toBe('allow');
  });
});
