const API_ROOT = 'https://api.github.com';
const USER_AGENT = 'Hawk-Update-Service/1';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  },
};

export async function route(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  if (url.pathname === '/health') {
    return json({ ok: true, service: 'hawk-update-service' });
  }

  const update = parseUpdatePath(url.pathname);
  if (update) return await updateResponse(request, env, update);
  const download = parseDownloadPath(url.pathname);
  if (download) return await downloadResponse(request, env, download);
  return new Response('not found', { status: 404 });
}

async function updateResponse(request, env, requestInfo) {
  if (requestInfo.quality !== (env.UPDATE_CHANNEL || 'stable')) {
    return new Response(null, { status: 204 });
  }
  const release = await latestRelease(env);
  const manifest = await releaseManifest(env, release);
  if (manifest.commit && manifest.commit.toLowerCase() === requestInfo.commit.toLowerCase()) {
    return new Response(null, { status: 204 });
  }

  const assetName = selectAssetName(requestInfo.platform, manifest);
  if (!assetName) return new Response(null, { status: 204 });
  const asset = manifest.assets.find((candidate) => candidate.name === assetName);
  if (!asset) return new Response(null, { status: 204 });

  const origin = new URL(request.url).origin;
  const publishedAt = manifest.publishedAt || release.published_at || new Date().toISOString();
  const response = {
    url: `${origin}/download/${encodeURIComponent(asset.name)}?tag=${encodeURIComponent(manifest.tag)}`,
    version: manifest.commit || manifest.tag,
    productVersion: manifest.version,
    timestamp: Date.parse(publishedAt),
    sha256hash: asset.sha256,
    name: `Hawk Security IDE ${manifest.version}`,
    notes: release.body || `Hawk Security IDE ${manifest.version}`,
    pub_date: publishedAt,
  };
  return request.method === 'HEAD'
    ? new Response(null, { status: 200, headers: responseHeaders() })
    : json(response, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function downloadResponse(request, env, requestInfo) {
  const release = await releaseByTag(env, requestInfo.tag);
  const manifest = await releaseManifest(env, release);
  const declared = manifest.assets.find((asset) => asset.name === requestInfo.name);
  if (!declared) return new Response('asset is not declared by the signed release manifest', { status: 404 });
  const asset = release.assets?.find((candidate) => candidate.name === requestInfo.name);
  if (!asset?.url) return new Response('asset not found', { status: 404 });

  const upstream = await githubFetch(asset.url, env, {
    headers: { Accept: 'application/octet-stream' },
  });
  if (!upstream.ok) {
    throw new Error(`GitHub asset download failed (${upstream.status})`);
  }
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${safeFilename(asset.name)}"`);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('ETag', `"sha256-${declared.sha256}"`);
  if (upstream.headers.get('Content-Length')) {
    headers.set('Content-Length', upstream.headers.get('Content-Length'));
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: 200,
    headers,
  });
}

export function parseUpdatePath(pathname) {
  const match = pathname.match(
    /^\/api\/update\/([a-z0-9-]+)\/([a-z0-9-]+)\/([0-9a-f]{40})$/i,
  );
  return match
    ? { platform: match[1], quality: match[2], commit: match[3] }
    : undefined;
}

export function parseDownloadPath(pathname) {
  const match = pathname.match(/^\/download\/([^/]+)$/);
  if (!match) return undefined;
  const name = decodeURIComponent(match[1]);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{1,180}$/.test(name)) return undefined;
  return { name };
}

export function selectAssetName(platform, manifest) {
  const version = manifest.version;
  const desired = {
    'win32-x64': `HawkSetup-windows-x64-${version}.exe`,
    'win32-x64-user': `HawkSetup-windows-x64-${version}.exe`,
    'win32-x64-archive': `Hawk-windows-x64-${version}-portable.zip`,
    'linux-x64': `Hawk-linux-x64-${version}.AppImage`,
    darwin: `Hawk-macos-x64-${version}.zip`,
    'darwin-arm64': `Hawk-macos-arm64-${version}.zip`,
  }[platform];
  return desired && manifest.assets.some((asset) => asset.name === desired) ? desired : undefined;
}

async function latestRelease(env) {
  return await githubJSON(
    `${API_ROOT}/repos/${repository(env)}/releases/latest`,
    env,
  );
}

async function releaseByTag(env, tag) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag || '')) {
    throw new Error('invalid release tag');
  }
  return await githubJSON(
    `${API_ROOT}/repos/${repository(env)}/releases/tags/${encodeURIComponent(tag)}`,
    env,
  );
}

async function releaseManifest(env, release) {
  const asset = release.assets?.find((candidate) => candidate.name === 'update.json');
  if (!asset?.url) throw new Error('latest Hawk release does not contain update.json');
  const response = await githubFetch(asset.url, env, {
    headers: { Accept: 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`update manifest download failed (${response.status})`);
  const manifest = await response.json();
  validateManifest(manifest);
  return manifest;
}

function validateManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.product !== 'hawk-security-ide' ||
    typeof value.version !== 'string' ||
    typeof value.tag !== 'string' ||
    !Array.isArray(value.assets)
  ) {
    throw new Error('invalid Hawk update manifest');
  }
  for (const asset of value.assets) {
    if (
      typeof asset.name !== 'string' ||
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(asset.sha256)
    ) {
      throw new Error('invalid Hawk update asset declaration');
    }
  }
}

async function githubJSON(url, env) {
  const response = await githubFetch(url, env);
  if (!response.ok) throw new Error(`GitHub release request failed (${response.status})`);
  return await response.json();
}

function githubFetch(url, env, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  if (env.GITHUB_TOKEN) headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  return fetch(url, { ...init, headers, redirect: 'follow' });
}

function repository(env) {
  const value = env.GITHUB_REPOSITORY || 'MrBoodj011/hawk';
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(value)) {
    throw new Error('invalid GitHub repository configuration');
  }
  return value;
}

function responseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...responseHeaders(), ...extraHeaders },
  });
}

function safeFilename(value) {
  return value.replace(/[^0-9A-Za-z._-]/g, '_');
}
