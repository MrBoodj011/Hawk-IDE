import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryClient, normalizeError, sanitizeProperties } from './telemetry.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelemetryClient', () => {
  it('is completely silent by default', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TelemetryClient({
      endpoint: '',
      installationId: '',
      release: 'test',
      platform: 'test',
      enabled: false,
      crashReportingEnabled: false,
    });
    await expect(client.capture('app_started')).resolves.toBe(false);
    await expect(client.captureCrash(new Error('boom'))).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends allowlisted metadata only after opt-in', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TelemetryClient({
      endpoint: 'https://api.hawk.test/v1/telemetry/events',
      installationId: 'a'.repeat(32),
      release: '0.2.0',
      platform: 'win32',
      enabled: true,
      crashReportingEnabled: true,
    });
    await expect(
      client.capture('agent_task_completed', { durationMs: 42, sourceCode: 'secret' }),
    ).resolves.toBe(true);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.properties.durationMs).toBe(42);
    expect(body.properties.sourceCode).toBeUndefined();
  });

  it('sends crash fingerprints without messages, paths, or stack traces', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TelemetryClient({
      endpoint: 'https://api.hawk.test/v1/telemetry/events',
      installationId: 'b'.repeat(32),
      release: '0.2.0',
      platform: 'linux',
      enabled: false,
      crashReportingEnabled: true,
    });
    const error = new Error('token at C:\\Users\\alice\\private.ts:12:4');
    await client.captureCrash(error);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.properties.errorName).toBe('Error');
    expect(body.properties.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(body)).not.toContain('alice');
    expect(JSON.stringify(body)).not.toContain('private.ts');
  });
});

describe('telemetry sanitization', () => {
  it('blocks content-bearing property names', () => {
    expect(
      sanitizeProperties({
        durationMs: 10,
        prompt: 'private',
        repositoryUrl: 'private',
        success: true,
      }),
    ).toEqual({ durationMs: 10, success: true });
  });

  it('normalizes crash fingerprints across local line changes', () => {
    const one = new Error('failure');
    one.stack = 'Error: failure\n at run (C:\\Users\\a\\app.ts:10:2)';
    const two = new Error('failure');
    two.stack = 'Error: failure\n at run (C:\\Users\\b\\app.ts:99:8)';
    expect(normalizeError(one).fingerprint).toBe(normalizeError(two).fingerprint);
  });
});
