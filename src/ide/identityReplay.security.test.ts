import { describe, expect, it } from 'vitest';
import type { CapturedRequest } from '../browser/store.js';
import { IdentityReplayService } from './identityReplay.js';

const captured: CapturedRequest = {
  id: 'captured-security',
  source: 'webRequest',
  method: 'GET',
  url: 'https://api.example.test:8443/private?token=must-not-appear',
  requestHeaders: [{ name: 'Accept', value: 'application/json' }],
  receivedAt: Date.now(),
};

function identities(
  firstHeaders: Record<string, string> = { Authorization: 'Bearer first-secret-value' },
): Array<{ id: string; label: string; headers: Record<string, string> }> {
  return [
    { id: 'first', label: 'First account', headers: firstHeaders },
    {
      id: 'second',
      label: 'Second account',
      headers: { Cookie: 'session=second-secret-value' },
    },
  ];
}

describe('IdentityReplayService security corpus', () => {
  it.each([
    'api.example.test',
    'api.example.test:443',
    'evil.example.test:8443',
    'api.example.test:8443/path',
    'user@api.example.test:8443',
    'api.example.test:8443?token=secret',
    'api.example.test:8443#fragment',
    'api.example.test:8443\r\nx-injected: yes',
  ])('rejects authority drift: %s', (allowedHost) => {
    const service = new IdentityReplayService((id) => (id === captured.id ? captured : undefined));
    expect(() =>
      service.createPlan({
        requestId: captured.id,
        allowedHost,
        identities: identities(),
      }),
    ).toThrow('exactly match');
  });

  it.each([
    ['Host', 'api.example.test'],
    ['Content-Length', '12'],
    ['Proxy-Authorization', 'Basic secret'],
    ['Authorization\r\nX-Evil', 'Bearer value'],
    ['Authorization', 'Bearer okay\r\nX-Evil: yes'],
    ['Cookie', ''],
  ])('rejects forbidden or injected credential header %s', (name, value) => {
    const service = new IdentityReplayService((id) => (id === captured.id ? captured : undefined));
    expect(() =>
      service.createPlan({
        requestId: captured.id,
        allowedHost: 'api.example.test:8443',
        identities: identities({ [name]: value }),
      }),
    ).toThrow();
  });

  it('binds the approval hash to credential bytes without serializing them', () => {
    const service = new IdentityReplayService((id) => (id === captured.id ? captured : undefined));
    const first = service.createPlan({
      requestId: captured.id,
      allowedHost: 'api.example.test:8443',
      identities: identities({ Authorization: 'Bearer credential-one-000000' }),
    });
    const second = service.createPlan({
      requestId: captured.id,
      allowedHost: 'api.example.test:8443',
      identities: identities({ Authorization: 'Bearer credential-two-000000' }),
    });
    expect(first.approvalHash).not.toBe(second.approvalHash);
    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toContain('credential-one');
    expect(serialized).not.toContain('credential-two');
    expect(first.request.url).toBe('https://api.example.test:8443/private');
  });

  it('redacts fetch failures before returning an observation', async () => {
    const service = new IdentityReplayService(
      (id) => (id === captured.id ? captured : undefined),
      () => new Date('2026-07-20T12:00:00.000Z'),
      async () => {
        throw new Error(
          'Authorization: Bearer super-secret-credential-123456 https://api.example.test/private?token=raw',
        );
      },
    );
    const plan = service.createPlan({
      requestId: captured.id,
      allowedHost: 'api.example.test:8443',
      maxRequestsPerSecond: 5,
      identities: identities(),
    });
    const result = await service.execute({
      planId: plan.id,
      approvalHash: plan.approvalHash,
      approved: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('token=raw');
    expect(serialized).not.toContain('first-secret');
    expect(result.observations[0]?.error).toContain('[REDACTED]');
  });
});
