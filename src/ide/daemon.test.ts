import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startIdeDaemon } from './daemon.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('startIdeDaemon', () => {
  it('keeps the local API token-gated and returns a route inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pentesterflow-ide-daemon-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'server.ts'), "app.get('/api/profile', handler);\n");
    const daemon = await startIdeDaemon({ workspaceRoot: root, token: 'test-token' });
    try {
      const blocked = await fetch(`${daemon.url}/v1/health`);
      expect(blocked.status).toBe(401);

      const headers = { 'X-Hawk-Token': daemon.token };
      const health = await fetch(`${daemon.url}/v1/health`, { headers });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, protocolVersion: 5 });

      const indexed = await fetch(`${daemon.url}/v1/workspace/index`, { method: 'POST', headers });
      expect(indexed.status).toBe(200);
      await expect(indexed.json()).resolves.toMatchObject({
        sourceFiles: 1,
        routes: [expect.objectContaining({ method: 'GET', path: '/api/profile' })],
      });

      await writeFile(join(root, 'risky.ts'), 'eval(untrustedInput);\n');
      const audit = await fetch(`${daemon.url}/v1/audit/static`, { method: 'POST', headers });
      expect(audit.status).toBe(200);
      const audited = (await audit.json()) as { findings: Array<{ id: string; ruleId: string }> };
      expect(audited.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'dynamic-code-execution' })]),
      );

      const finding = audited.findings.find((item) => item.ruleId === 'dynamic-code-execution');
      expect(finding).toBeDefined();
      await writeFile(join(root, 'risky.ts'), 'const safe = true;\n');
      const retest = await fetch(`${daemon.url}/v1/findings/${finding?.id}/retest`, {
        method: 'POST',
        headers,
      });
      expect(retest.status).toBe(200);
      await expect(retest.json()).resolves.toMatchObject({
        present: false,
        finding: { status: 'fixed' },
      });

      const traffic = await fetch(`${daemon.url}/v1/traffic/import/har`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          log: {
            entries: [
              {
                request: { method: 'GET', url: 'https://api.example.test/orders?token=private' },
                response: { status: 200 },
              },
            ],
          },
        }),
      });
      expect(traffic.status).toBe(200);
      await expect(traffic.json()).resolves.toMatchObject({
        requests: [
          expect.objectContaining({ url: 'https://api.example.test/orders?token=REDACTED' }),
        ],
      });

      const captured = await fetch(`${daemon.captureUrl}/ingest`, {
        method: 'POST',
        headers: {
          'X-Hawk-Token': daemon.captureToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'burp',
          id: 44,
          method: 'POST',
          url: 'https://api.example.test/orders?authorization=private',
          status: 201,
          timeStart: Date.now() - 25,
          timeEnd: Date.now(),
          elapsedMs: 25,
        }),
      });
      expect(captured.status).toBe(202);
      const liveTraffic = await fetch(`${daemon.url}/v1/traffic`, { headers });
      expect(liveTraffic.status).toBe(200);
      await expect(liveTraffic.json()).resolves.toMatchObject({
        source: 'mixed',
        live: true,
        requests: expect.arrayContaining([
          expect.objectContaining({
            source: 'burp',
            url: 'https://api.example.test/orders?authorization=REDACTED',
          }),
        ]),
      });

      const hawk = await fetch(`${daemon.url}/v1/hawk/health/import`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: 'example-org',
          summary: { repositories: 1, criticalSecurityAlerts: 1 },
          repositories: [
            {
              name: 'payments-api',
              securityAlerts: 1,
              securityBreakdown: { critical: 1 },
              securitySla: { total: 1 },
              sbom: { packageCount: 24, unknownLicenses: 0 },
            },
          ],
        }),
      });
      expect(hawk.status).toBe(200);
      await expect(hawk.json()).resolves.toMatchObject({
        organization: 'example-org',
        priorityQueue: [expect.objectContaining({ name: 'payments-api', level: 'critical' })],
      });
      await expect(fetch(`${daemon.url}/v1/hawk/health`, { headers })).resolves.toMatchObject({
        status: 200,
      });

      const scanTemplates = await fetch(`${daemon.url}/v1/scans/templates`, { headers });
      expect(scanTemplates.status).toBe(200);
      await expect(scanTemplates.json()).resolves.toMatchObject({
        templates: [
          expect.objectContaining({ id: 'passive-workspace' }),
          expect.objectContaining({ id: 'runtime-observe' }),
          expect.objectContaining({ id: 'release-gate' }),
        ],
      });
      const scanPlan = await fetch(`${daemon.url}/v1/scans/plan?templateId=passive-workspace`, {
        headers,
      });
      expect(scanPlan.status).toBe(200);
      const plan = (await scanPlan.json()) as {
        templateId: string;
        approvalHash: string;
        requiresApproval: boolean;
      };
      expect(plan).toMatchObject({
        templateId: 'passive-workspace',
        requiresApproval: true,
        approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const rejectedScan = await fetch(`${daemon.url}/v1/scans/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: false,
          templateId: plan.templateId,
          approvalHash: plan.approvalHash,
        }),
      });
      expect(rejectedScan.status).toBe(400);
      const completedScan = await fetch(`${daemon.url}/v1/scans/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          templateId: plan.templateId,
          approvalHash: plan.approvalHash,
        }),
      });
      expect(completedScan.status).toBe(200);
      await expect(completedScan.json()).resolves.toMatchObject({
        scope: 'passive-workspace',
        reportPath: expect.stringMatching(/^\.hawk\/reports\//),
      });
      const evidence = await fetch(`${daemon.url}/v1/reports/evidence`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      expect(evidence.status).toBe(200);
      await expect(evidence.json()).resolves.toMatchObject({
        status: 'completed',
        primaryReportPath: expect.stringMatching(/^\.hawk\/reports\/evidence-.+\/report\.md$/),
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            format: 'sarif',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      });
      const mission = await fetch(`${daemon.url}/v1/missions/plan`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: 'Review authentication routes and preserve evidence',
          profile: 'review',
          hosts: [],
        }),
      });
      expect(mission.status).toBe(200);
      await expect(mission.json()).resolves.toMatchObject({
        profile: 'review',
        allowedActions: ['read-workspace'],
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reportPath: expect.stringMatching(/^\.hawk\/plans\/plan-.+\.md$/),
      });
    } finally {
      await daemon.close();
    }
  });
});
