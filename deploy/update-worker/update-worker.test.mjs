import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeChannel,
  parseDownloadPath,
  parseUpdatePath,
  releaseMatchesChannel,
  selectAssetName,
} from './worker.mjs';

describe('Hawk update channels', () => {
  it('maps native Code-OSS insider quality to beta', () => {
    assert.equal(normalizeChannel('stable'), 'stable');
    assert.equal(normalizeChannel('beta'), 'beta');
    assert.equal(normalizeChannel('insider'), 'beta');
    assert.equal(normalizeChannel('dev'), undefined);
  });

  it('selects only signed-manifest release candidates for each channel', () => {
    const stable = {
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [{ name: 'update.json' }],
    };
    const beta = {
      tag_name: 'v1.3.0-beta.2',
      draft: false,
      prerelease: true,
      assets: [{ name: 'update.json' }],
    };
    assert.equal(releaseMatchesChannel(stable, 'stable'), true);
    assert.equal(releaseMatchesChannel(stable, 'beta'), false);
    assert.equal(releaseMatchesChannel(beta, 'beta'), true);
    assert.equal(releaseMatchesChannel({ ...stable, assets: [] }, 'stable'), false);
  });

  it('parses native update and safe download routes', () => {
    const commit = 'a'.repeat(40);
    assert.deepEqual(parseUpdatePath(`/api/update/win32-x64/insider/${commit}`), {
      platform: 'win32-x64',
      quality: 'insider',
      commit,
    });
    assert.deepEqual(parseDownloadPath('/download/HawkSetup-windows-x64-1.2.3.exe'), {
      name: 'HawkSetup-windows-x64-1.2.3.exe',
    });
    assert.equal(parseDownloadPath('/download/..%2Fsecret'), undefined);
  });

  it('chooses platform assets declared by the manifest', () => {
    const manifest = {
      version: '1.2.3',
      assets: [{ name: 'Hawk-linux-x64-1.2.3.AppImage' }],
    };
    assert.equal(selectAssetName('linux-x64', manifest), 'Hawk-linux-x64-1.2.3.AppImage');
    assert.equal(selectAssetName('win32-x64', manifest), undefined);
  });
});
