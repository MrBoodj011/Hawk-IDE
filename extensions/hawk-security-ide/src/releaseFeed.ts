import { createHash } from 'node:crypto';
import { isValidReleaseVersion } from './releaseSemver';

export const HAWK_RELEASE_REPOSITORY = 'MrBoodj011/hawk';
export const DEFAULT_HAWK_UPDATE_FEED = 'https://mrboodj011.github.io/hawk/updates/feed.json';

export interface HawkFeedAsset {
  name: string;
  url: string;
  browser_download_url: string;
  size: number;
}

export interface HawkFeedRelease {
  tag_name: string;
  html_url: string;
  name: string;
  draft: false;
  prerelease: boolean;
  assets: HawkFeedAsset[];
  rollout?: {
    percentage: number;
    seed: string;
    startsAt: string;
  };
}

export interface HawkUpdateFeed {
  schemaVersion: 1;
  product: 'Hawk Security IDE';
  repository: typeof HAWK_RELEASE_REPOSITORY;
  generatedAt: string;
  channels: {
    stable: HawkFeedRelease[];
    beta: HawkFeedRelease[];
    canary: HawkFeedRelease[];
  };
}

export function validateUpdateFeedUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('The Hawk production update feed must use HTTPS without URL credentials.');
  }
  return url.toString();
}

export function eligibleForRollout(
  release: HawkFeedRelease,
  machineId: string,
  now: Date = new Date(),
): boolean {
  const policy = release.rollout;
  if (!policy) return true;
  if (Date.parse(policy.startsAt) > now.getTime()) return false;
  if (policy.percentage >= 100) return true;
  if (policy.percentage <= 0) return false;
  const digest = createHash('sha256')
    .update(`${policy.seed}\u0000${release.tag_name}\u0000${machineId}`)
    .digest();
  const bucket = (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
  return bucket < policy.percentage;
}

export function parseHawkUpdateFeed(value: unknown): HawkUpdateFeed {
  const input = record(value, 'update feed');
  if (input.schemaVersion !== 1) throw new Error('Unsupported Hawk update feed schema.');
  if (input.product !== 'Hawk Security IDE') throw new Error('Update feed product mismatch.');
  if (input.repository !== HAWK_RELEASE_REPOSITORY) {
    throw new Error('Update feed repository mismatch.');
  }
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error('Update feed generatedAt is invalid.');
  }
  const channels = record(input.channels, 'update feed channels');
  return {
    schemaVersion: 1,
    product: 'Hawk Security IDE',
    repository: HAWK_RELEASE_REPOSITORY,
    generatedAt: input.generatedAt,
    channels: {
      stable: parseChannel(channels.stable, false),
      beta: parseChannel(channels.beta, true),
      canary: parseChannel(channels.canary ?? channels.beta, true),
    },
  };
}

function parseChannel(value: unknown, allowPrerelease: boolean): HawkFeedRelease[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error('A Hawk update channel must be an array with at most 50 releases.');
  }
  return value.map((entry) => parseRelease(entry, allowPrerelease));
}

function parseRelease(value: unknown, allowPrerelease: boolean): HawkFeedRelease {
  const input = record(value, 'release');
  if (typeof input.tag_name !== 'string' || !isValidReleaseVersion(input.tag_name)) {
    throw new Error('Update feed contains an invalid release version.');
  }
  if (input.draft !== false || typeof input.prerelease !== 'boolean') {
    throw new Error('Update feed contains an unpublished release.');
  }
  if (!allowPrerelease && input.prerelease) {
    throw new Error('Stable update feed contains a prerelease.');
  }
  if (typeof input.name !== 'string' || input.name.length > 300) {
    throw new Error('Update feed release name is invalid.');
  }
  const releaseUrl = trustedUrl(input.html_url, ['github.com'], '/MrBoodj011/hawk/releases/');
  if (!Array.isArray(input.assets) || input.assets.length > 100) {
    throw new Error('Update feed release assets are invalid.');
  }
  return {
    tag_name: input.tag_name,
    html_url: releaseUrl,
    name: input.name,
    draft: false,
    prerelease: input.prerelease,
    assets: input.assets.map(parseAsset),
    ...(input.rollout ? { rollout: parseRollout(input.rollout) } : {}),
  };
}

function parseRollout(value: unknown): NonNullable<HawkFeedRelease['rollout']> {
  const input = record(value, 'release rollout');
  if (
    typeof input.percentage !== 'number' ||
    !Number.isFinite(input.percentage) ||
    input.percentage < 0 ||
    input.percentage > 100 ||
    typeof input.seed !== 'string' ||
    input.seed.length < 1 ||
    input.seed.length > 160 ||
    typeof input.startsAt !== 'string' ||
    !Number.isFinite(Date.parse(input.startsAt))
  ) {
    throw new Error('Update feed rollout policy is invalid.');
  }
  return {
    percentage: input.percentage,
    seed: input.seed,
    startsAt: input.startsAt,
  };
}

function parseAsset(value: unknown): HawkFeedAsset {
  const input = record(value, 'release asset');
  if (
    typeof input.name !== 'string' ||
    input.name.length < 1 ||
    input.name.length > 260 ||
    input.name.includes('/') ||
    input.name.includes('\\')
  ) {
    throw new Error('Update feed asset name is invalid.');
  }
  if (!Number.isSafeInteger(input.size) || Number(input.size) <= 0) {
    throw new Error('Update feed asset size is invalid.');
  }
  return {
    name: input.name,
    url: trustedUrl(input.url, ['api.github.com'], '/repos/MrBoodj011/hawk/releases/assets/'),
    browser_download_url: trustedUrl(
      input.browser_download_url,
      ['github.com'],
      '/MrBoodj011/hawk/releases/download/',
    ),
    size: Number(input.size),
  };
}

function trustedUrl(value: unknown, hosts: string[], pathPrefix: string): string {
  if (typeof value !== 'string') throw new Error('Update feed URL is invalid.');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    !url.pathname.toLowerCase().startsWith(pathPrefix.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new Error('Update feed points outside official Hawk release infrastructure.');
  }
  return url.toString();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Hawk ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}
