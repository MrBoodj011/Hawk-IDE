import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repository = 'MrBoodj011/hawk';
const fromVersion = argument('--from') || '0.2.0';
const requestedTag = argument('--to');
const requireSignature = process.argv.includes('--require-signature');
const expectedPublisher = (process.env.HAWK_WINDOWS_PUBLISHER || '').trim();
const outputRoot = resolve(argument('--output') || '.tmp/updater-test');
const maxAssetBytes = 1_500_000_000;

const token = await githubToken();
const releaseEndpoint = requestedTag
  ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(requestedTag)}`
  : `https://api.github.com/repos/${repository}/releases/latest`;
const release = await githubJson(
  releaseEndpoint,
  token,
);
if (release.draft) throw new Error(`${release.tag_name} is still a draft.`);
if (compareVersions(release.tag_name, fromVersion) <= 0) {
  throw new Error(`${release.tag_name} is not newer than ${fromVersion}.`);
}
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const asset = release.assets.find((candidate) =>
  new RegExp(`^HawkSetup-windows-${architecture}-.+\\.exe$`, 'i').test(candidate.name),
);
if (!asset) throw new Error(`No Windows ${architecture} installer exists in ${release.tag_name}.`);
if (asset.size <= 0 || asset.size > maxAssetBytes) {
  throw new Error(`Installer metadata has an invalid size: ${asset.size}.`);
}
const checksumAsset = release.assets.find((candidate) => candidate.name === 'SHA256SUMS');
if (!checksumAsset) throw new Error(`${release.tag_name} has no SHA256SUMS asset.`);
const checksumBody = await downloadText(checksumAsset.url, token);
const expectedHash = checksumForAsset(checksumBody, asset.name);
const directory = join(outputRoot, normalizeVersion(release.tag_name));
await mkdir(directory, { recursive: true });
const installer = join(directory, basename(asset.name));
let downloaded = false;
const existingHash = await sha256File(installer).catch(() => '');
if (existingHash !== expectedHash) {
  await downloadFile(asset.url, installer, token, asset.size);
  downloaded = true;
}
const info = await stat(installer);
if (info.size !== asset.size) {
  throw new Error(`Downloaded size mismatch: expected ${asset.size}, received ${info.size}.`);
}
const actualHash = await sha256File(installer);
if (actualHash !== expectedHash) throw new Error('Real updater test failed SHA-256 verification.');
const handle = await open(installer, 'r');
const headerBuffer = Buffer.alloc(2);
try {
  await handle.read(headerBuffer, 0, 2, 0);
} finally {
  await handle.close();
}
const header = headerBuffer.toString('ascii');
if (header !== 'MZ') throw new Error('Downloaded update is not a Windows PE executable.');
const signature = process.platform === 'win32' ? await authenticode(installer) : undefined;
if (requireSignature && signature?.status !== 'Valid') {
  throw new Error(`Authenticode is required but ${asset.name} is ${signature?.status ?? 'unknown'}.`);
}
if (
  expectedPublisher &&
  signature &&
  !signature.subject.toLowerCase().includes(expectedPublisher.toLowerCase())
) {
  throw new Error(
    `Authenticode publisher "${signature.subject}" does not match "${expectedPublisher}".`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: `${normalizeVersion(fromVersion)} -> ${normalizeVersion(release.tag_name)}`,
      release: release.html_url,
      asset: asset.name,
      bytes: info.size,
      downloaded,
      sha256: actualHash,
      checksumVerified: true,
      peHeaderVerified: true,
      authenticode: signature ?? { status: 'not-checked', reason: 'non-Windows host' },
      expectedPublisher: expectedPublisher || undefined,
      installerLaunched: false,
      note: 'The test exercises the real private GitHub feed and full asset download but never launches the installer.',
    },
    null,
    2,
  ),
);

async function githubToken() {
  const fromEnvironment = process.env.HAWK_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnvironment) return fromEnvironment.trim();
  const result = await execFileAsync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  const value = result.stdout.trim();
  if (!value) throw new Error('Authenticate GitHub CLI or set HAWK_GITHUB_TOKEN.');
  return value;
}

async function githubJson(url, secret) {
  const response = await fetch(url, { headers: githubHeaders(secret, false) });
  if (!response.ok) throw new Error(`GitHub release request failed (${response.status}).`);
  return await response.json();
}

async function downloadText(url, secret) {
  assertGitHubAssetUrl(url);
  const response = await fetch(url, { headers: githubHeaders(secret, true), redirect: 'follow' });
  if (!response.ok) throw new Error(`Checksum download failed (${response.status}).`);
  assertGitHubDownloadUrl(response.url);
  return (await response.text()).slice(0, 2_000_000);
}

async function downloadFile(url, destination, secret, expectedBytes) {
  assertGitHubAssetUrl(url);
  const response = await fetch(url, { headers: githubHeaders(secret, true), redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Installer download failed (${response.status}).`);
  }
  assertGitHubDownloadUrl(response.url);
  const contentLength = Number(response.headers.get('content-length') || expectedBytes);
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maxAssetBytes) {
    throw new Error(`Unsafe installer Content-Length: ${contentLength}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { mode: 0o700 }),
  );
}

function githubHeaders(secret, binary) {
  return {
    Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    Authorization: `Bearer ${secret}`,
    'User-Agent': 'Hawk-Real-Updater-Test',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function assertGitHubAssetUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'api.github.com' && url.hostname !== 'github.com')
  ) {
    throw new Error(`Refusing non-GitHub asset URL: ${url.hostname}.`);
  }
}

function assertGitHubDownloadUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    ![
      'api.github.com',
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ].includes(url.hostname)
  ) {
    throw new Error(`Refusing redirected asset host: ${url.hostname}.`);
  }
}

function checksumForAsset(body, name) {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2]?.trim() === name) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS does not list ${name}.`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function authenticode(path) {
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}'`,
    '[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject; Thumbprint = [string]$s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  const value = JSON.parse(result.stdout.trim());
  return {
    status: value.Status || 'Unknown',
    subject: value.Subject || '',
    thumbprint: value.Thumbprint || '',
  };
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map((value) => Number.parseInt(value, 10) || 0);
  const b = normalizeVersion(right).split('.').map((value) => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function normalizeVersion(value) {
  return String(value).trim().replace(/^v/i, '').replace(/[-+].*$/, '');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
