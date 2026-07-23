import { describe, expect, it } from 'vitest';
import { summarizeSecurityBenchmark } from './securityBenchmark.js';

describe('security benchmark', () => {
  it('reports reproduction, false positives, fixes, timing, memory and cost', () => {
    const report = summarizeSecurityBenchmark(
      [
        {
          repo: 'acme/a',
          findingId: '1',
          detected: true,
          reproduced: true,
          truth: 'true-positive',
          fixed: true,
          testsPassed: true,
          durationMs: 100,
          memoryBytes: 1000,
          costUsd: 0.01,
        },
        {
          repo: 'acme/a',
          findingId: '2',
          detected: true,
          reproduced: false,
          truth: 'false-positive',
          durationMs: 300,
          memoryBytes: 2000,
          costUsd: 0.02,
        },
        {
          repo: 'acme/b',
          findingId: '3',
          detected: false,
          reproduced: false,
          truth: 'unknown',
          durationMs: 200,
        },
      ],
      'public-fixtures',
      new Date('2026-07-23T00:00:00.000Z'),
    );
    expect(report).toMatchObject({
      repos: 2,
      samples: 3,
      findings: 2,
      reproductionRate: 0.5,
      falsePositiveRate: 0.5,
      fixSuccessRate: 1,
      testsPassRate: 1,
      timing: { p50Ms: 200, p95Ms: 300 },
      memory: { peakBytes: 2000 },
      cost: { totalUsd: 0.03 },
    });
  });
});
