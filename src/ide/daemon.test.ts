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

      const headers = { 'X-Pentesterflow-Token': daemon.token };
      const health = await fetch(`${daemon.url}/v1/health`, { headers });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, protocolVersion: 1 });

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
    } finally {
      await daemon.close();
    }
  });
});
