import { describe, expect, it } from 'vitest';
import { createIntegrationPlan, listHawkIntegrations } from './integrationHub.js';

describe('Hawk integration hub', () => {
  it('advertises the governed delivery and capture integrations', () => {
    expect(listHawkIntegrations().map((item) => item.id)).toEqual([
      'github',
      'gitlab',
      'jira',
      'slack',
      'burp',
      'browser',
      'ci-cd',
      'docker',
      'kubernetes',
    ]);
  });

  it('creates a redacted, expiring integration plan with a stable approval hash', () => {
    const plan = createIntegrationPlan({
      integration: 'slack',
      action: 'post approval request',
      target: '#security',
      payloadSummary: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      now: new Date('2026-07-23T00:00:00.000Z'),
    });
    expect(plan).toMatchObject({
      integration: 'slack',
      target: '#security',
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(plan.payloadSummary).toContain('[REDACTED');
  });
});
