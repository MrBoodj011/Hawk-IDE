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
    } finally {
      await daemon.close();
    }
  });
});
