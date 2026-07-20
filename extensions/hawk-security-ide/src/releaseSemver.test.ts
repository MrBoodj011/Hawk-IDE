import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  isValidReleaseVersion,
  normalizeReleaseVersion,
} from './releaseSemver';

describe('Hawk release SemVer ordering', () => {
  it('normalizes GitHub tags and strips development suffixes', () => {
    expect(normalizeReleaseVersion('  v1.2.3-dev.4 ')).toBe('1.2.3');
  });

  it('prefers newer stable releases over older releases', () => {
    expect(compareReleaseVersions('v1.10.0', 'v1.9.9')).toBeGreaterThan(0);
  });

  it('gives stable releases precedence over a same-version beta', () => {
    expect(compareReleaseVersions('v2.0.0', 'v2.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareReleaseVersions('v2.0.0-beta.2', 'v2.0.0-beta.10')).toBeLessThan(0);
  });

  it('rejects tags that could escape the local update directory', () => {
    expect(isValidReleaseVersion('v0.7.1')).toBe(true);
    expect(isValidReleaseVersion('v0.7.1-beta.2')).toBe(true);
    expect(isValidReleaseVersion('v../../latest')).toBe(false);
    expect(isValidReleaseVersion('latest')).toBe(false);
  });
});
