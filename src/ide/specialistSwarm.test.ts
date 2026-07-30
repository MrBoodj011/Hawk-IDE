import { describe, expect, it } from 'vitest';
import { planSpecialistSwarm } from './specialistSwarm.js';

describe('specialist swarm', () => {
  it('builds a scoped eight-agent dependency graph', () => {
    const plan = planSpecialistSwarm({
      objective: 'Validate the checkout workflow and prepare an evidence-backed fix',
      maxParallel: 99,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });
    expect(plan).toMatchObject({
      maxParallel: 8,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'agent-race-condition', authority: 'approval-gated-active' }),
        expect.objectContaining({
          id: 'agent-fix',
          dependencies: expect.arrayContaining(['agent-debug']),
        }),
        expect.objectContaining({
          id: 'agent-independent-verifier',
          dependencies: ['agent-fix'],
        }),
      ]),
    });
    expect(plan.nodes).toHaveLength(8);
    expect(() => planSpecialistSwarm({ objective: ' ' })).toThrow('objective');
  });
});
