import { describe, expect, it } from 'vitest';
import {
  parseDownloadPath,
  parseUpdatePath,
  selectAssetName,
} from '../../deploy/update-worker/worker.mjs';

describe('Hawk update service routing', () => {
  it('parses only native Code-OSS update routes with a full commit', () => {
    expect(
      parseUpdatePath('/api/update/win32-x64/stable/1234567890abcdef1234567890abcdef12345678'),
    ).toEqual({
      platform: 'win32-x64',
      quality: 'stable',
      commit: '1234567890abcdef1234567890abcdef12345678',
    });
    expect(parseUpdatePath('/api/update/win32-x64/stable/main')).toBeUndefined();
    expect(parseDownloadPath('/download/../../secret')).toBeUndefined();
  });

  it('maps every shipped desktop platform to the exact release asset', () => {
    const version = '0.2.0';
    const names = [
      `HawkSetup-windows-x64-${version}.exe`,
      `Hawk-windows-x64-${version}-portable.zip`,
      `Hawk-linux-x64-${version}.AppImage`,
      `Hawk-macos-x64-${version}.zip`,
      `Hawk-macos-arm64-${version}.zip`,
    ];
    const manifest = {
      version,
      assets: names.map((name) => ({ name })),
    };
    expect(selectAssetName('win32-x64', manifest)).toBe(names[0]);
    expect(selectAssetName('win32-x64-archive', manifest)).toBe(names[1]);
    expect(selectAssetName('linux-x64', manifest)).toBe(names[2]);
    expect(selectAssetName('darwin', manifest)).toBe(names[3]);
    expect(selectAssetName('darwin-arm64', manifest)).toBe(names[4]);
  });
});
