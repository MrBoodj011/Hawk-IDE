import { describe, expect, it } from 'vitest';
import { assertInstallerURL } from './selfUpdate.js';

describe('assertInstallerURL (L10)', () => {
  it('accepts the canonical https githubusercontent installer URL', () => {
    expect(() =>
      assertInstallerURL('https://raw.githubusercontent.com/MrBoodj011/Hawk-IDE/main/install.sh'),
    ).not.toThrow();
    expect(() =>
      assertInstallerURL('https://raw.githubusercontent.com/MrBoodj011/Hawk-IDE/v0.7.0/install.sh'),
    ).not.toThrow();
  });

  it('rejects a non-https scheme', () => {
    expect(() =>
      assertInstallerURL('http://raw.githubusercontent.com/MrBoodj011/Hawk-IDE/main/install.sh'),
    ).toThrow(/non-https/);
    expect(() => assertInstallerURL('file:///etc/passwd')).toThrow(/non-https/);
  });

  it('rejects an unexpected host (tampered HAWK_REPO)', () => {
    expect(() => assertInstallerURL('https://evil.example.com/x/main/install.sh')).toThrow(
      /unexpected host/,
    );
  });

  it('pins executable installer scripts to the canonical Hawk repository', () => {
    expect(() =>
      assertInstallerURL('https://raw.githubusercontent.com/attacker/Hawk-IDE/main/install.sh'),
    ).toThrow(/outside trusted repository/);
    expect(() =>
      assertInstallerURL(
        'https://raw.githubusercontent.com/trusted/fork/main/install.sh',
        'trusted/fork',
      ),
    ).not.toThrow();
  });

  it('rejects a malformed URL', () => {
    expect(() => assertInstallerURL('not a url')).toThrow(/invalid installer URL/);
  });

  it('rejects embedded URL credentials', () => {
    expect(() =>
      assertInstallerURL(
        'https://user:secret@raw.githubusercontent.com/MrBoodj011/Hawk-IDE/main/install.sh',
      ),
    ).toThrow(/embedded credentials/);
  });
});
