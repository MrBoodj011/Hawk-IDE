import { describe, expect, it } from 'vitest';
import { parseHawkUpdateFeed, validateUpdateFeedUrl } from './releaseFeed';

const release = {
  tag_name: 'v0.7.1',
  html_url: 'https://github.com/MrBoodj011/hawk/releases/tag/v0.7.1',
  name: 'Hawk Security IDE v0.7.1',
  draft: false,
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
      channels: { stable: [release], beta: [release] },
    });
    expect(result.channels.stable[0]?.tag_name).toBe('v0.7.1');
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
});
