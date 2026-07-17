import { describe, expect, it } from 'vitest';
import { estimateParallelExecution } from './orchestrationEstimate.js';

describe('estimateParallelExecution', () => {
  it('shows the lower bound for independent work', () => {
    const estimate = estimateParallelExecution(
      [
        { id: 'a', estimatedMinutes: 120 },
        { id: 'b', estimatedMinutes: 120 },
        { id: 'c', estimatedMinutes: 120 },
        { id: 'd', estimatedMinutes: 120 },
      ],
      4,
      0,
    );
    expect(estimate).toMatchObject({
      totalWorkerMinutes: 480,
      criticalPathMinutes: 120,
      theoreticalLowerBoundMinutes: 120,
      theoreticalSpeedup: 4,
      parallelizable: true,
    });
  });

  it('does not claim speedup for a fully sequential chain', () => {
    const estimate = estimateParallelExecution(
      [
        { id: 'a', estimatedMinutes: 60 },
        { id: 'b', estimatedMinutes: 60, dependsOn: ['a'] },
        { id: 'c', estimatedMinutes: 60, dependsOn: ['b'] },
      ],
      8,
      0,
    );
    expect(estimate.criticalPathMinutes).toBe(180);
    expect(estimate.theoreticalSpeedup).toBe(1);
    expect(estimate.parallelizable).toBe(false);
  });
});
