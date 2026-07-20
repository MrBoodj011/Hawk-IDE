import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedRequest } from '../browser/store.js';
import { IdentityReplayService } from './identityReplay.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('IdentityReplayService', () => {
  it('binds memory-only credentials to an expiring plan and compares bounded responses', async () => {
    const target = http.createServer((request, response) => {
      const owner = request.headers.authorization === 'Bearer owner-secret';
      response.writeHead(owner ? 200 : 403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(owner ? { object: 'owner-record' } : { error: 'forbidden' }));
    });
    servers.push(target);
    const port = await listen(target);
    const captured: CapturedRequest = {
      id: 'capture-1',
      source: 'webRequest',
      method: 'GET',
      url: `http://127.0.0.1:${port}/api/orders/42?view=full`,
      requestHeaders: [{ name: 'Accept', value: 'application/json' }],
      receivedAt: Date.now(),
    };
    const service = new IdentityReplayService((id) => (id === captured.id ? captured : undefined));
    const plan = service.createPlan({
      requestId: captured.id,
      allowedHost: `127.0.0.1:${port}`,
      maxRequestsPerSecond: 5,
      identities: [
        {
          id: 'owner',
          label: 'Object owner',
          headers: { Authorization: 'Bearer owner-secret' },
        },
        {
          id: 'other-user',
          label: 'Different account',
          headers: { Authorization: 'Bearer other-secret' },
        },
      ],
    });

    expect(plan.request).toMatchObject({
      method: 'GET',
      url: `http://127.0.0.1:${port}/api/orders/42`,
    });
    expect(plan.identities).toEqual([
      { id: 'owner', label: 'Object owner', headerNames: ['Authorization'] },
      { id: 'other-user', label: 'Different account', headerNames: ['Authorization'] },
    ]);
    expect(JSON.stringify(plan)).not.toContain('owner-secret');
    expect(JSON.stringify(plan)).not.toContain('other-secret');

    const result = await service.execute({
      planId: plan.id,
      approvalHash: plan.approvalHash,
      approved: true,
    });
    expect(result.observations).toEqual([
      expect.objectContaining({ identityId: 'owner', status: 200, matchesBaseline: true }),
      expect.objectContaining({ identityId: 'other-user', status: 403, matchesBaseline: false }),
    ]);
    expect(JSON.stringify(result)).not.toContain('owner-record');
    await expect(
      service.execute({ planId: plan.id, approvalHash: plan.approvalHash, approved: true }),
    ).rejects.toThrow('not found or has expired');
  });

  it('refuses scope drift and non-credential identity headers', () => {
    const captured: CapturedRequest = {
      id: 'capture-2',
      source: 'webRequest',
      method: 'GET',
      url: 'https://api.example.com/private',
      receivedAt: Date.now(),
    };
    const service = new IdentityReplayService((id) => (id === captured.id ? captured : undefined));
    expect(() =>
      service.createPlan({
        requestId: captured.id,
        allowedHost: 'evil.example',
        identities: [
          { id: 'a', label: 'A', headers: { Authorization: 'Bearer a' } },
          { id: 'b', label: 'B', headers: { Authorization: 'Bearer b' } },
        ],
      }),
    ).toThrow('exactly match');
    expect(() =>
      service.createPlan({
        requestId: captured.id,
        allowedHost: 'api.example.com',
        identities: [
          { id: 'a', label: 'A', headers: { Accept: 'application/json' } },
          { id: 'b', label: 'B', headers: { Authorization: 'Bearer b' } },
        ],
      }),
    ).toThrow('needs Authorization');
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Target server has no TCP address');
  return address.port;
}
