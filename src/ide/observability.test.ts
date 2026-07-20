import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HawkObservability } from './observability.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('HawkObservability', () => {
  it('records bounded route metrics without query strings or dynamic identifiers', () => {
    const clock = new Date('2026-07-20T12:00:00.000Z');
    const observability = new HawkObservability(() => clock);
    const first = observability.start(
      'get',
      '/v1/ai/sessions/12345678-1234-1234-1234-123456789abc/events?token=secret',
    );
    observability.finish(first, 200);
    const second = observability.start('POST', '/v1/findings/123/retest?authorization=secret');
    observability.finish(second, 503);

    const snapshot = observability.snapshot();
    expect(snapshot.totals).toMatchObject({
      requests: 2,
      errors: 1,
      active: 0,
      status2xx: 1,
      status5xx: 1,
    });
    expect(snapshot.recentTraces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          route: '/v1/ai/sessions/:id/events',
          status: 200,
        }),
        expect.objectContaining({
          method: 'POST',
          route: '/v1/findings/:number/retest',
          status: 503,
        }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('token=');
  });

  it('builds an approved private debug bundle with a matching manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-observability-'));
    roots.push(root);
    const clock = new Date('2026-07-20T12:34:56.000Z');
    const observability = new HawkObservability(() => clock);
    const trace = observability.start('GET', '/v1/health');
    observability.finish(trace, 200);

    await expect(
      observability.buildDebugBundle({ approved: false, workspaceRoot: root }),
    ).rejects.toThrow('approval');
    const result = await observability.buildDebugBundle({
      approved: true,
      workspaceRoot: root,
      extra: { protocolVersion: 12, findings: 0 },
    });
    const body = await readFile(result.path, 'utf8');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      sha256: string;
      bytes: number;
    };
    expect(manifest).toMatchObject({
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
    });
    expect(JSON.parse(body)).toMatchObject({
      schemaVersion: 1,
      extra: { protocolVersion: 12, findings: 0 },
      privacy: expect.stringContaining('No source code'),
    });
    expect((await lstat(result.path)).isSymbolicLink()).toBe(false);
  });

  it('rejects secret-shaped metadata from diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-observability-secret-'));
    roots.push(root);
    const observability = new HawkObservability();
    await expect(
      observability.buildDebugBundle({
        approved: true,
        workspaceRoot: root,
        extra: { authorization: 'Bearer do-not-write' },
      }),
    ).rejects.toThrow('secret-shaped');
  });
});
