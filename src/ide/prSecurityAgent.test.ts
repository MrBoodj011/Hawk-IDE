import { describe, expect, it } from 'vitest';
import { analyzePullRequestDiff, pullRequestReportToSarif } from './prSecurityAgent.js';

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
