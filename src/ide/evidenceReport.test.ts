import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePack } from './evidenceReport.js';
import type { TrafficInventory } from './protocol.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('evidence report builder', () => {
  it('requires approval and writes portable Markdown, HTML, JSON, SARIF, and hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-evidence-'));
    roots.push(root);
    await writeFile(join(root, 'server.ts'), "app.get('/users/:id', handler);\neval(input);\n");
    const traffic: TrafficInventory = {
      protocolVersion: 5,
      importedAt: '2026-07-18T10:00:00.000Z',
      source: 'live',
      hosts: ['example.test'],
      requests: [
        {
          id: 'R-1',
          method: 'GET',
          url: 'https://example.test/users/42?token=%5BREDACTED%5D',
          host: 'example.test',
          startedAt: '2026-07-18T10:00:00.000Z',
          source: 'browser',
          status: 200,
        },
      ],
      truncated: false,
      live: true,
    };

    await expect(buildEvidencePack({ workspaceRoot: root, approved: false })).rejects.toThrow(
      'approval',
    );
    const report = await buildEvidencePack({
      workspaceRoot: root,
      approved: true,
      traffic,
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    expect(report).toMatchObject({
      routes: 1,
      observedRoutes: 1,
      trafficRequests: 1,
      findings: 1,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          format: 'markdown',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ format: 'html' }),
        expect.objectContaining({ format: 'sarif' }),
      ]),
    });
    const markdown = await readFile(join(root, ...report.primaryReportPath.split('/')), 'utf8');
    expect(markdown).toContain('GET /users/:id');
    expect(markdown).toContain('%5BREDACTED%5D');
    expect(markdown).not.toContain(root);
    const sarifPath = report.artifacts.find((artifact) => artifact.format === 'sarif')?.path;
    expect(sarifPath).toBeTruthy();
    const sarif = JSON.parse(await readFile(join(root, ...(sarifPath ?? '').split('/')), 'utf8'));
    expect(sarif).toMatchObject({
      version: '2.1.0',
      runs: [{ results: [expect.objectContaining({ ruleId: 'dynamic-code-execution' })] }],
    });
  });
});
