import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const repository = argument('--repository') || process.env.GITHUB_REPOSITORY || 'MrBoodj011/hawk';
const output = resolve(argument('--output') || 'artifacts/update-feed.json');
const token = process.env.GITHUB_TOKEN || process.env.HAWK_GITHUB_TOKEN || '';

if (repository !== 'MrBoodj011/hawk') {
  throw new Error('The production feed generator is pinned to MrBoodj011/hawk.');
}

const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
  headers: {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Hawk-Update-Feed-Builder',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});
if (!response.ok) throw new Error(`GitHub Releases API returned HTTP ${response.status}.`);

const releases = (await response.json())
  .filter((release) => !release.draft && validVersion(release.tag_name))
  .map(normalizeRelease)
  .filter(releaseReadyForUpdater);
if (!releases.length) {
  throw new Error('No published Hawk release contains SHA256SUMS and a desktop installer.');
}

const feed = {
  schemaVersion: 1,
  product: 'Hawk Security IDE',
  repository,
  generatedAt: new Date().toISOString(),
  channels: {
    stable: releases.filter((release) => !release.prerelease),
    beta: releases,
  },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(feed, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
process.stdout.write(
  `${JSON.stringify({ output, stable: feed.channels.stable.length, beta: feed.channels.beta.length })}\n`,
);

function normalizeRelease(release) {
  return {
    tag_name: release.tag_name,
    html_url: release.html_url,
    name: String(release.name || release.tag_name).slice(0, 300),
    draft: false,
    prerelease: Boolean(release.prerelease),
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({
          name: asset.name,
          url: asset.url,
          browser_download_url: asset.browser_download_url,
          size: asset.size,
        }))
      : [],
  };
}

function releaseReadyForUpdater(release) {
  const names = release.assets.map((asset) => asset.name);
  return (
    names.includes('SHA256SUMS') &&
    names.some((name) => /^HawkSetup-windows-(?:x64|arm64)-.+\.exe$/i.test(name))
  );
}

function validVersion(value) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || ''));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
