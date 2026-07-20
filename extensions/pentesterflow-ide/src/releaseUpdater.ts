import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import {
  compareReleaseVersions,
  isValidReleaseVersion,
  normalizeReleaseVersion,
} from './releaseSemver.js';
import { verifyWindowsAuthenticode } from './windowsAuthenticode.js';

const REPOSITORY = 'MrBoodj011/hawk';
const RELEASE_TOKEN_KEY = 'hawk.releaseToken';
const MAX_ASSET_BYTES = 1_500_000_000;

interface ReleaseAsset {
  name: string;
  url: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

/** Private GitHub Release updater with checksum verification and explicit install approval. */
export class HawkReleaseUpdater implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private startupTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.commands.registerCommand('hawk.checkForUpdates', async () => {
        await this.check(true);
      }),
      vscode.commands.registerCommand('hawk.configureReleaseToken', async () => {
        const token = await vscode.window.showInputBox({
          title: 'Hawk Private Release Access',
          prompt:
            'Paste a GitHub token with read access to the private Hawk repository. It stays in Hawk encrypted local secret storage.',
          password: true,
          ignoreFocusOut: true,
        });
        if (token === undefined) return;
        if (token.trim()) await this.context.secrets.store(RELEASE_TOKEN_KEY, token.trim());
        else await this.context.secrets.delete(RELEASE_TOKEN_KEY);
        vscode.window.showInformationMessage(
          token.trim() ? 'Hawk release access configured.' : 'Hawk release access cleared.',
        );
      }),
    );

    if (vscode.workspace.getConfiguration('hawk').get<boolean>('updates.checkOnStartup', true)) {
      this.startupTimer = setTimeout(() => {
        void this.check(false);
      }, 8_000);
    }
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  async check(interactive: boolean): Promise<void> {
    const token =
      (await this.context.secrets.get(RELEASE_TOKEN_KEY)) ||
      process.env.HAWK_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      '';
    const channel = vscode.workspace
      .getConfiguration('hawk')
      .get<'stable' | 'beta'>('updates.channel', 'stable');
    const expectedPublisher = vscode.workspace
      .getConfiguration('hawk')
      .get<string>('updates.expectedPublisher', '');
    let releases: GitHubRelease[];
    try {
      releases = await fetchReleases(token);
    } catch (error) {
      if (interactive) {
        const action = await vscode.window.showWarningMessage(
          `Hawk could not read the private release feed: ${errorMessage(error)}`,
          'Configure access',
        );
        if (action === 'Configure access') {
          await vscode.commands.executeCommand('hawk.configureReleaseToken');
        }
      }
      return;
    }
    // GitHub normally returns releases newest-first, but that ordering is not
    // part of the API contract. Sort explicitly so a delayed/older release
    // cannot mask the newest eligible update (especially on the beta channel).
    const release = releases
      .filter(
        (candidate) =>
          !candidate.draft &&
          isValidReleaseVersion(candidate.tag_name) &&
          (channel === 'beta' || candidate.prerelease === false),
      )
      .sort((left, right) =>
        compareReleaseVersions(right.tag_name, left.tag_name),
      )[0];
    if (!release) {
      if (interactive) vscode.window.showInformationMessage('No Hawk release is available yet.');
      return;
    }
    const currentVersion = String(this.context.extension.packageJSON.version ?? '0.0.0');
    if (
      compareReleaseVersions(release.tag_name, currentVersion) <= 0
    ) {
      if (interactive) {
        vscode.window.showInformationMessage(`Hawk ${currentVersion} is up to date.`);
      }
      return;
    }
    const asset = selectPlatformAsset(release.assets);
    if (!asset) {
      if (interactive) {
        vscode.window
          .showWarningMessage(
            `Hawk ${release.tag_name} is available, but it has no installer for this platform.`,
            'Open release',
          )
          .then((action) => {
            if (action === 'Open release')
              void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
          });
      }
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `Hawk ${release.tag_name} is ready. Hawk will verify SHA-256, exact size, and its trusted Windows publisher before install.`,
      { modal: interactive },
      process.platform === 'win32' ? 'Download and install' : 'Download update',
      'Open release',
    );
    if (action === 'Open release') {
      await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
      return;
    }
    if (action !== 'Download and install' && action !== 'Download update') return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading Hawk ${release.tag_name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Downloading checksum manifest and installer…' });
        const installer = await downloadVerifiedAsset(
          release,
          asset,
          token,
          this.context.globalStorageUri.fsPath,
          expectedPublisher,
        );
        if (process.platform === 'win32') {
          const approval = await vscode.window.showWarningMessage(
            `Run the verified Hawk installer ${basename(installer)}?`,
            { modal: true },
            'Install Hawk update',
          );
          if (approval !== 'Install Hawk update') return;
          const child = spawn(installer, [], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          child.unref();
          vscode.window.showInformationMessage(
            'Hawk installer started. Save your work before the installer replaces the application.',
          );
        } else {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(installer));
        }
      },
    );
  }
}

async function fetchReleases(token: string): Promise<GitHubRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'private repository access is not configured'
        : `GitHub returned HTTP ${response.status}`,
    );
  }
  return (await response.json()) as GitHubRelease[];
}

async function downloadVerifiedAsset(
  release: GitHubRelease,
  asset: ReleaseAsset,
  token: string,
  storageRoot: string,
  expectedPublisher: string,
): Promise<string> {
  validateDownloadUrl(asset.url);
  if (asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
    throw new Error(`Release asset has an invalid size: ${asset.size}`);
  }
  const checksums = release.assets.find((candidate) => candidate.name === 'SHA256SUMS');
  if (!checksums) throw new Error('Release is missing SHA256SUMS.');
  validateDownloadUrl(checksums.url);
  const checksumResponse = await fetch(checksums.url, {
    headers: githubHeaders(token, true),
  });
  if (!checksumResponse.ok)
    throw new Error(`Could not download SHA256SUMS (${checksumResponse.status}).`);
  validateDownloadResponseUrl(checksumResponse.url);
  const checksumBody = (await checksumResponse.text()).slice(0, 2_000_000);
  const expectedHash = checksumForAsset(checksumBody, asset.name);
  const directory = join(storageRoot, 'updates', normalizeReleaseVersion(release.tag_name));
  await mkdir(directory, { recursive: true });
  const target = join(directory, basename(asset.name));
  const response = await fetch(asset.url, { headers: githubHeaders(token, true) });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${asset.name} (${response.status}).`);
  }
  validateDownloadResponseUrl(response.url);
  const contentLength = Number(response.headers.get('content-length') ?? asset.size);
  if (!Number.isFinite(contentLength) || contentLength > MAX_ASSET_BYTES) {
    throw new Error('Release asset exceeds the Hawk updater size limit.');
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(target, { mode: 0o700 }),
  );
  const info = await stat(target);
  if (info.size !== asset.size) {
    await unlink(target).catch(() => undefined);
    throw new Error(
      `Downloaded Hawk installer size mismatch (${info.size} received, ${asset.size} expected).`,
    );
  }
  const actualHash = await sha256File(target);
  if (actualHash !== expectedHash) {
    await unlink(target).catch(() => undefined);
    throw new Error('Downloaded Hawk installer failed SHA-256 verification.');
  }
  if (process.platform === 'win32') {
    try {
      await verifyWindowsAuthenticode(target, expectedPublisher);
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
  return target;
}

function selectPlatformAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') {
    return assets.find((asset) =>
      new RegExp(`^HawkSetup-windows-${architecture}-.+\\.exe$`, 'i').test(asset.name),
    );
  }
  if (process.platform === 'linux') {
    return assets.find((asset) =>
      new RegExp(`^Hawk-linux-${architecture}-.+\\.(?:AppImage|deb)$`, 'i').test(asset.name),
    );
  }
  return undefined;
}

function checksumForAsset(body: string, assetName: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2]?.trim() === assetName) return match[1]?.toLowerCase() ?? '';
  }
  throw new Error(`SHA256SUMS does not contain ${assetName}.`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function validateDownloadUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'github.com' && url.hostname !== 'api.github.com')
  ) {
    throw new Error('Refusing a non-GitHub release asset URL.');
  }
}

function validateDownloadResponseUrl(value: string): void {
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
    throw new Error('Refusing an update redirected outside trusted GitHub asset hosts.');
  }
}

function githubHeaders(token: string, binary = false): Record<string, string> {
  return {
    Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    'User-Agent': 'Hawk-Security-IDE',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
