import { describe, expect, it } from 'vitest';
import { importSarifFindings, listSecurityAdapters } from './securityAdapters.js';

describe('security adapter registry', () => {
  it('normalizes SARIF findings and redacts credential-shaped messages', () => {
    const imported = importSarifFindings(
      'codeql',
      {
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: {
                rules: [{ id: 'js/sql-injection', name: 'SQL injection' }],
              },
            },
            results: [
              {
                ruleId: 'js/sql-injection',
                level: 'error',
                message: { text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/routes.ts' },
                      region: { startLine: 42 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      'codeql.sarif',
      new Date('2026-07-23T00:00:00.000Z'),
    );

    expect(imported).toMatchObject({ adapter: 'codeql', truncated: false });
    expect(imported.findings).toHaveLength(1);
    expect(imported.findings[0]).toMatchObject({
      ruleId: 'codeql:js/sql-injection',
      title: 'SQL injection',
      severity: 'high',
      source: { file: 'src/routes.ts', line: 42 },
    });
    expect(imported.findings[0]?.description).toContain('[REDACTED');
  });

  it('rejects unsupported SARIF versions and exposes the adapter capabilities', () => {
    expect(listSecurityAdapters().map((adapter) => adapter.id)).toEqual([
      'codeql',
      'semgrep',
      'zap',
      'nuclei',
      'trivy',
      'oss-fuzz',
    ]);
    expect(() => importSarifFindings('semgrep', { version: '2.0.0', runs: [] })).toThrow(
      'SARIF 2.1.0',
    );
  });
});
