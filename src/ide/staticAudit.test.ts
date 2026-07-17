import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanWorkspaceSecurity } from './staticAudit.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('scanWorkspaceSecurity', () => {
  it('reports passive code signals without leaking a credential literal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pentesterflow-static-audit-'));
    temporaryRoots.push(root);
    await writeFile(
      join(root, 'server.ts'),
      [
        "const apiKey = 'super-secret-value';",
        'const agent = new https.Agent({ rejectUnauthorized: false });',
        'eval(untrustedInput);',
      ].join('\n'),
    );

    const result = await scanWorkspaceSecurity(root, new Date('2026-07-17T12:00:00.000Z'));

    expect(result).toMatchObject({ sourceFiles: 1, scannedAt: '2026-07-17T12:00:00.000Z' });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'hardcoded-secret',
          severity: 'high',
          source: { file: 'server.ts', line: 1 },
        }),
        expect.objectContaining({
          ruleId: 'tls-verification-disabled',
          source: { file: 'server.ts', line: 2 },
        }),
        expect.objectContaining({
          ruleId: 'dynamic-code-execution',
          source: { file: 'server.ts', line: 3 },
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});
