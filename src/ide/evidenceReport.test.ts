import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBehavioralSecurity } from './behavioralSecurity.js';
import { buildEvidencePack } from './evidenceReport.js';
import { analyzeInteractionChaos } from './interactionChaos.js';
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
    const capturedInteractions = [0, 100, 180].map((offset, index) => ({
      id: `interaction-${index}`,
      kind: 'submit' as const,
      url: 'https://example.test/users/42',
      occurredAt: 1_768_734_000_000 + offset,
      receivedAt: 1_768_734_000_000 + offset,
      trusted: true,
      tabId: 5,
      target: {
        fingerprint: 'form > button[type="submit"]',
        tag: 'button',
        inputType: 'submit',
      },
    }));
    const interactionChaos = analyzeInteractionChaos(
      capturedInteractions,
      [0, 120].map((offset, index) => ({
        id: `mutation-${index}`,
        kind: 'fetch' as const,
        source: 'webRequest' as const,
        method: 'POST',
        url: 'https://example.test/users/42',
        receivedAt: 1_768_734_000_200 + offset,
        timeStart: 1_768_734_000_200 + offset,
        tabId: 5,
        status: 201,
        initiator: 'https://example.test/users/42',
        requestHeaders: {},
        responseHeaders: {},
      })),
      { now: new Date('2026-01-18T10:00:01.000Z') },
    );
    const behavioralSecurity = analyzeBehavioralSecurity({
      inventory: {
        protocolVersion: 13,
        root,
        indexedAt: '2026-07-18T10:00:00.000Z',
        sourceFiles: 1,
        routes: [
          {
            method: 'GET',
            path: '/users/:id',
            file: 'server.ts',
            line: 1,
            framework: 'express',
          },
        ],
      },
      traffic,
      interactions: capturedInteractions,
      interactionChaos,
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    const report = await buildEvidencePack({
      workspaceRoot: root,
      approved: true,
      traffic,
      interactionChaos,
      behavioralSecurity,
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    expect(report).toMatchObject({
      routes: 1,
      observedRoutes: 1,
      trafficRequests: 1,
      findings: 1,
      interactionSignals: 1,
      behavioralSignals: expect.any(Number),
      chainVersion: 1,
      chainRootSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          format: 'markdown',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ format: 'html' }),
        expect.objectContaining({ format: 'sarif' }),
      ]),
    });
    const chained = report.artifacts.filter((artifact) => artifact.entrySha256);
    expect(chained.length).toBeGreaterThanOrEqual(4);
    expect(chained[0]).toMatchObject({ previousSha256: '0'.repeat(64) });
    expect(chained.every((artifact) => artifact.entrySha256?.match(/^[a-f0-9]{64}$/))).toBe(true);
    const markdown = await readFile(join(root, ...report.primaryReportPath.split('/')), 'utf8');
    expect(markdown).toContain('GET /users/:id');
    expect(markdown).toContain('%5BREDACTED%5D');
    expect(markdown).toContain('hawk.ui.rapid-submit');
    expect(markdown).toContain('Behavioral Intelligence');
    expect(markdown).not.toContain(root);
    const sarifPath = report.artifacts.find((artifact) => artifact.format === 'sarif')?.path;
    expect(sarifPath).toBeTruthy();
    const sarif = JSON.parse(await readFile(join(root, ...(sarifPath ?? '').split('/')), 'utf8'));
    expect(sarif).toMatchObject({
      version: '2.1.0',
      runs: [
        {
          results: expect.arrayContaining([
            expect.objectContaining({ ruleId: 'dynamic-code-execution' }),
            expect.objectContaining({ ruleId: 'hawk.ui.rapid-submit' }),
            expect.objectContaining({ ruleId: expect.stringMatching(/^hawk\.behavior\./) }),
          ]),
        },
      ],
    });
  });
});
