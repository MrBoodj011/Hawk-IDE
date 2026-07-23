import { describe, expect, it } from 'vitest';
import { eligibleForRollout, parseHawkUpdateFeed, validateUpdateFeedUrl } from './releaseFeed';

const release = {
  tag_name: 'v0.7.1',
  html_url: 'https://github.com/MrBoodj011/hawk/releases/tag/v0.7.1',
  name: 'Hawk Security IDE v0.7.1',
  draft: false as const,
  prerelease: false,
  assets: [
    {
      name: 'SHA256SUMS',
      url: 'https://api.github.com/repos/MrBoodj011/hawk/releases/assets/123',
      browser_download_url:
        'https://github.com/MrBoodj011/hawk/releases/download/v0.7.1/SHA256SUMS',
      size: 96,
    },
  ],
};

describe('Hawk production update feed', () => {
  it('accepts a release feed bound to the official repository', () => {
    const result = parseHawkUpdateFeed({
      schemaVersion: 1,
      product: 'Hawk Security IDE',
      repository: 'MrBoodj011/hawk',
      generatedAt: '2026-07-21T00:00:00.000Z',
      channels: {
        stable: [
          {
            ...release,
            rollout: { percentage: 100, seed: 'stable', startsAt: '2026-07-21T00:00:00.000Z' },
          },
        ],
        beta: [release],
        canary: [
          {
            ...release,
            rollout: { percentage: 10, seed: 'canary', startsAt: '2026-07-21T00:00:00.000Z' },
          },
        ],
      },
    });
    expect(result.channels.stable[0]?.tag_name).toBe('v0.7.1');
    expect(result.channels.canary[0]?.rollout?.percentage).toBe(10);
  });

  it('rejects assets outside the official GitHub repository', () => {
    expect(() =>
      parseHawkUpdateFeed({
        schemaVersion: 1,
        product: 'Hawk Security IDE',
        repository: 'MrBoodj011/hawk',
        generatedAt: '2026-07-21T00:00:00.000Z',
        channels: {
          stable: [
            {
              ...release,
              assets: [{ ...release.assets[0], url: 'https://evil.example/update.exe' }],
            },
          ],
          beta: [],
        },
      }),
    ).toThrow(/outside official/);
  });

  it('requires HTTPS for a configured feed', () => {
    expect(() => validateUpdateFeedUrl('http://updates.example/feed.json')).toThrow(/HTTPS/);
  });

  it('uses a stable machine cohort for staged rollout', () => {
    const staged = {
      ...release,
      rollout: {
        percentage: 0,
        seed: 'canary',
        startsAt: '2026-07-21T00:00:00.000Z',
      },
    };
    expect(eligibleForRollout(staged, 'machine-a', new Date('2026-07-22T00:00:00Z'))).toBe(false);
    expect(
      eligibleForRollout(
        { ...staged, rollout: { ...staged.rollout, percentage: 100 } },
        'machine-a',
        new Date('2026-07-22T00:00:00Z'),
      ),
    ).toBe(true);
  });
});
