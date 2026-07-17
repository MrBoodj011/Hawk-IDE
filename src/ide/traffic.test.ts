import { describe, expect, it } from 'vitest';
import { importHarTraffic, importLiveTraffic, mergeTrafficInventories } from './traffic.js';

describe('importHarTraffic', () => {
  it('imports only a redacted request inventory and never keeps sensitive query values', () => {
    const result = importHarTraffic(
      {
        log: {
          entries: [
            {
              startedDateTime: '2026-07-17T12:00:00.000Z',
              request: {
                method: 'GET',
                url: 'https://api.example.test/orders?token=do-not-store&filter=recent',
              },
              response: { status: 200 },
            },
          ],
        },
      },
      new Date('2026-07-17T13:00:00.000Z'),
    );

    expect(result).toMatchObject({
      source: 'har',
      hosts: ['api.example.test'],
      requests: [
        {
          method: 'GET',
          url: 'https://api.example.test/orders?token=REDACTED&filter=recent',
          status: 200,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('do-not-store');
  });

  it('rejects non-HAR JSON', () => {
    expect(() => importHarTraffic({ nope: [] })).toThrow('HAR is missing its log object');
  });

  it('redacts live capture metadata and merges it with imported traffic', () => {
    const live = importLiveTraffic(
      [
        {
          id: 'burp:42',
          source: 'burp',
          method: 'POST',
          url: 'https://api.example.test/orders?api_key=do-not-store',
          status: 201,
          timeStart: Date.parse('2026-07-17T12:00:00.000Z'),
          timeEnd: Date.parse('2026-07-17T12:00:00.125Z'),
          elapsedMs: 125,
          receivedAt: Date.parse('2026-07-17T12:00:00.125Z'),
        },
      ],
      new Date('2026-07-17T12:01:00.000Z'),
    );
    const imported = importHarTraffic(
      {
        log: {
          entries: [
            {
              request: { method: 'GET', url: 'https://web.example.test/' },
              response: { status: 200 },
            },
          ],
        },
      },
      new Date('2026-07-17T12:01:00.000Z'),
    );
    const merged = mergeTrafficInventories(imported, live);

    expect(live).toMatchObject({
      source: 'live',
      live: true,
      requests: [
        {
          source: 'burp',
          url: 'https://api.example.test/orders?api_key=REDACTED',
          elapsedMs: 125,
        },
      ],
    });
    expect(merged).toMatchObject({
      source: 'mixed',
      live: true,
      hosts: ['api.example.test', 'web.example.test'],
    });
    expect(JSON.stringify(merged)).not.toContain('do-not-store');
  });
});
