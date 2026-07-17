import { describe, expect, it } from 'vitest';
import { importHarTraffic } from './traffic.js';

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
});
