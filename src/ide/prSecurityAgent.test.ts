import { describe, expect, it } from 'vitest';
import {
  analyzePullRequestDiff,
  pullRequestReportToSarif,
  reviewPullRequestEvidence,
} from './prSecurityAgent.js';

describe('PR Security Agent', () => {
  it('blocks critical secrets and reports review-grade policy changes', () => {
    const report = analyzePullRequestDiff(`diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,1 +1,3 @@
+const api_key = "super-secret-production-value";
+app.use(cors({ origin: "*" }));
+const ok = true;
`);
    expect(report.gate).toBe('block');
    expect(report.summary).toMatchObject({ critical: 1, medium: 1 });
    expect(report.findings[0]?.evidence).not.toContain('super-secret-production-value');
    expect(JSON.stringify(pullRequestReportToSarif(report))).toContain('Hawk PR Security Agent');
  });
});

describe('PR evidence review', () => {
  it('keeps findings below pass until every evidence gate succeeds', () => {
    const report = analyzePullRequestDiff(
      ['diff --git a/a.ts b/a.ts', '+++ b/a.ts', '@@ -0,0 +1 @@', '+eval(input)'].join('\n'),
      new Date('2026-07-29T00:00:00.000Z'),
    );
    const incomplete = reviewPullRequestEvidence(
      report,
      {
        reproductionPassed: false,
        testsPassed: true,
        semanticReviewPassed: true,
        independentReviewPassed: false,
        evidenceUris: [],
      },
      new Date('2026-07-29T00:01:00.000Z'),
    );
    expect(incomplete).toMatchObject({
      finalGate: 'review',
      missingGates: expect.arrayContaining([
        'reproduction',
        'independent review',
        'evidence provenance',
      ]),
    });
    const complete = reviewPullRequestEvidence(
      report,
      {
        reproductionPassed: true,
        testsPassed: true,
        semanticReviewPassed: true,
        independentReviewPassed: true,
        evidenceUris: ['hawk://finding/1/proof', 'not-a-uri'],
      },
      new Date('2026-07-29T00:02:00.000Z'),
    );
    expect(complete).toMatchObject({
      finalGate: 'pass',
      evidenceUris: ['hawk://finding/1/proof'],
      reviewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('never overrides deterministic blocking findings', () => {
    const report = analyzePullRequestDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '+++ b/a.ts',
        '@@ -0,0 +1 @@',
        '+const apiKey = "1234567890123456";',
      ].join('\n'),
    );
    const review = reviewPullRequestEvidence(report, {
      reproductionPassed: true,
      testsPassed: true,
      semanticReviewPassed: true,
      independentReviewPassed: true,
      evidenceUris: ['hawk://finding/1/proof'],
    });
    expect(review.finalGate).toBe('block');
  });
});
