import { describe, expect, it } from 'vitest';
import { importHawkHealthReport } from './hawkReport.js';

describe('importHawkHealthReport', () => {
  it('imports a Hawk health.json without retaining raw alert payloads', () => {
    const report = importHawkHealthReport(
      {
        generatedAt: '2026-07-17T10:00:00.000Z',
        organization: 'example-org',
        outcome: 'completed',
        summary: {
          repositories: 2,
          maintenanceScore: 81,
          highRiskRepositories: 1,
          criticalSecurityAlerts: 1,
          highSecurityAlerts: 2,
          securityAlerts: 3,
          sbomRepositories: 2,
        },
        repositories: [
          {
            name: 'payments-api',
            url: 'https://github.com/example-org/payments-api',
            securityAlerts: 3,
            securityBreakdown: { critical: 1, high: 2 },
            securitySla: { total: 1 },
            failedUpdatePulls: 1,
            sbom: { packageCount: 42, unknownLicenses: 2 },
            rawAlertPayload: { secret: 'must-not-be-kept' },
          },
        ],
      },
      new Date('2026-07-17T12:00:00.000Z'),
    );

    expect(report).toMatchObject({
      source: 'hawk-health-json',
      organization: 'example-org',
      summary: { repositories: 2, criticalSecurityAlerts: 1 },
      priorityQueue: [
        expect.objectContaining({ name: 'payments-api', level: 'critical', criticalAlerts: 1 }),
      ],
    });
    expect(JSON.stringify(report)).not.toContain('must-not-be-kept');
  });

  it('rejects a report without the Hawk summary', () => {
    expect(() => importHawkHealthReport({ repositories: [] })).toThrow('summary');
  });
});
