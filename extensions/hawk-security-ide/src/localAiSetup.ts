import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, stat, unlink } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import type { DaemonClient } from './daemonClient';
import {
  type LocalAiModelOption,
  localAiModelOptions,
  recommendLocalAiModel,
  validateOllamaReleaseAsset,
} from './localAiPolicy.js';

const OLLAMA_API_URL = 'http://127.0.0.1:11434';
const OLLAMA_RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const FIRST_RUN_KEY = 'hawk.localAI.firstRunOffered.v1';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface OllamaApiModel {
  name?: string;
  model?: string;
}

interface OllamaRelease {
  tag_name?: string;
  assets?: Array<{
    name?: string;
    size?: number;
    browser_download_url?: string;
    digest?: string | null;
  }>;
}

export interface HawkLocalAiStatus {
  installed: boolean;
  running: boolean;
  executable?: string;
  models: string[];
  configuredModel: string;
}

interface ModelPick extends vscode.QuickPickItem {
  model: string;
  approximateDownloadGb?: number;
}

/** Secure, user-approved Ollama bootstrap and local model configuration. */
export class HawkLocalAiSetup implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: DaemonClient,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.statusBar.command = 'hawk.setupLocalAI';
    this.statusBar.name = 'Hawk Local AI';
    this.statusBar.show();
    this.disposables.push(
      this.statusBar,
      vscode.commands.registerCommand('hawk.setupLocalAI', async () => {
        await this.setup();
      }),
      vscode.commands.registerCommand('hawk.showLocalAIStatus', async () => {
        const status = await this.inspect();
        await this.showStatus(status);
      }),
    );
    void this.refreshStatusBar();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  async offerFirstRun(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('hawk');
    if (!configuration.get<boolean>('localAI.offerSetupOnFirstRun', true)) return;
    if (this.context.globalState.get<boolean>(FIRST_RUN_KEY, false)) return;
    const provider = configuration.get<string>('preferredProvider', '').trim();
    if (provider && provider !== 'ollama') {
      await this.context.globalState.update(FIRST_RUN_KEY, true);
      return;
    }
    const status = await this.inspect();
    if (status.running && status.models.length > 0 && provider === 'ollama') {
      await this.context.globalState.update(FIRST_RUN_KEY, true);
      return;
    }
    await this.context.globalState.update(FIRST_RUN_KEY, true);
    const action = await vscode.window.showInformationMessage(
      status.installed
        ? 'Ollama is installed. Finish Hawk Local AI by choosing a coding model.'
        : 'Set up private local AI for Hawk? Ollama runs on this machine and requires no API key.',
      'Set up Hawk Local AI',
      'Not now',
    );
    if (action === 'Set up Hawk Local AI') await this.setup();
  }

  async inspect(): Promise<HawkLocalAiStatus> {
    const executable = findOllamaExecutable();
    const models = await fetchInstalledModels().catch(() => undefined);
    const configuredModel = vscode.workspace
      .getConfiguration('hawk')
      .get<string>('preferredModel', '')
      .trim();
    return {
      installed: Boolean(executable) || Boolean(models),
      running: Boolean(models),
      ...(executable ? { executable } : {}),
      models: models ?? [],
      configuredModel,
    };
  }

  async setup(): Promise<void> {
    if (process.platform !== 'win32') {
      const action = await vscode.window.showInformationMessage(
        'Automatic Hawk Local AI setup is currently available in the Windows installer.',
        'Open Ollama download',
      );
      if (action === 'Open Ollama download') {
        await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      }
      return;
    }

    try {
      let status = await this.inspect();
      const recommended = recommendLocalAiModel(totalmem());
      const selected = await chooseModel(status.models, recommended);
      if (!selected) return;
      const installedModel = status.models.includes(selected.model);
      const totalMemoryGb = Math.round(totalmem() / 1024 ** 3);
      if (!status.installed) {
        const approval = await vscode.window.showWarningMessage(
          `Hawk will download the official Ollama runtime (about 1.4 GB; at least 4 GB installed) and then ${selected.model} (about ${selected.approximateDownloadGb ?? 'several'} GB). This machine reports ${totalMemoryGb} GB RAM.`,
          { modal: true },
          'Install local AI',
        );
        if (approval !== 'Install local AI') return;
      } else if (!installedModel) {
        const approval = await vscode.window.showWarningMessage(
          `Download ${selected.model} for Hawk Local AI? The model is about ${selected.approximateDownloadGb ?? 'several'} GB and stays on this machine.`,
          { modal: true },
          'Download model',
        );
        if (approval !== 'Download model') return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Hawk Local AI setup',
          cancellable: true,
        },
        async (progress, token) => {
          if (!status.installed) {
            progress.report({ message: 'Preparing verified Ollama installer...' });
            await this.installOllama(progress, token);
          }
          status = await this.ensureOllamaRunning(progress, token);
          if (!status.models.includes(selected.model)) {
            const executable = status.executable ?? findOllamaExecutable();
            if (!executable) throw new Error('Ollama installed, but ollama.exe was not found.');
            await pullModel(executable, selected.model, progress, token);
          }
          progress.report({ message: 'Connecting Hawk to the local model...' });
          await configureHawkForOllama(selected.model);
          const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (workspace) await this.client.restart(workspace);
        },
      );
      await this.refreshStatusBar();
      vscode.window.showInformationMessage(
        `Hawk Local AI is ready with ${selected.model}. Prompts stay on this machine.`,
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        vscode.window.showInformationMessage('Hawk Local AI setup cancelled.');
        return;
      }
      await this.refreshStatusBar();
      vscode.window.showErrorMessage(`Hawk Local AI setup failed: ${errorMessage(error)}`);
    }
  }

  private async installOllama(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const releaseResponse = await fetch(OLLAMA_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Hawk-Security-IDE',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!releaseResponse.ok) {
      throw new Error(`GitHub returned HTTP ${releaseResponse.status} for Ollama releases.`);
    }
    const release = (await releaseResponse.json()) as OllamaRelease;
    const rawAsset = release.assets?.find((asset) => asset.name === 'OllamaSetup.exe');
    if (!rawAsset?.name || !rawAsset.browser_download_url || typeof rawAsset.size !== 'number') {
      throw new Error('The latest official Ollama release has no Windows installer.');
    }
    const asset = validateOllamaReleaseAsset({
      name: rawAsset.name,
      size: rawAsset.size,
      browser_download_url: rawAsset.browser_download_url,
      digest: rawAsset.digest,
    });
    const directory = join(
      this.context.globalStorageUri.fsPath,
      'local-ai',
      release.tag_name?.replace(/[^0-9A-Za-z._-]/g, '') || 'latest',
    );
    await mkdir(directory, { recursive: true });
    const installer = join(directory, basename(asset.name));
    if (!(await verifiedCachedFile(installer, asset.size, asset.sha256))) {
      await unlink(installer).catch(() => undefined);
      await downloadAsset(asset.downloadUrl, installer, asset.size, progress, token);
      const actualHash = await sha256File(installer);
      if (actualHash !== asset.sha256) {
        await unlink(installer).catch(() => undefined);
        throw new Error('Ollama installer failed SHA-256 verification.');
      }
    }
    progress.report({ message: 'Verifying Ollama Windows signature...' });
    await verifyAuthenticode(installer);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    progress.report({ message: 'Installing Ollama for this Windows account...' });
    const code = await waitForProcess(
      spawn(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], {
        windowsHide: true,
        stdio: 'ignore',
      }),
      token,
      30 * 60_000,
    );
    if (code !== 0) throw new Error(`Ollama installer exited with code ${code}.`);
    await unlink(installer).catch(() => undefined);
  }

  private async ensureOllamaRunning(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<HawkLocalAiStatus> {
    let status = await this.inspect();
    if (status.running) return status;
    const executable = status.executable ?? findOllamaExecutable();
    if (!executable) throw new Error('ollama.exe was not found after installation.');
    progress.report({ message: 'Starting the local Ollama service...' });
    const child = spawn(executable, ['serve'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      await delay(750);
      status = await this.inspect();
      if (status.running) return status;
    }
    throw new Error('Ollama did not start its local API on port 11434.');
  }

  private async refreshStatusBar(): Promise<void> {
    const status = await this.inspect().catch(() => undefined);
    if (status?.running && status.models.length > 0) {
      this.statusBar.text = '$(sparkle) Hawk Local';
      this.statusBar.tooltip = `Hawk Local AI ready: ${status.configuredModel || status.models[0]}`;
      this.statusBar.backgroundColor = undefined;
      return;
    }
    if (status?.installed) {
      this.statusBar.text = '$(cloud-download) Finish Local AI';
      this.statusBar.tooltip = 'Ollama is installed; choose a local coding model.';
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    this.statusBar.text = '$(sparkle) Set up Local AI';
    this.statusBar.tooltip = 'Install verified Ollama and a hardware-sized coding model.';
    this.statusBar.backgroundColor = undefined;
  }

  private async showStatus(status: HawkLocalAiStatus): Promise<void> {
    if (!status.installed) {
      const action = await vscode.window.showInformationMessage(
        'Hawk Local AI is not installed.',
        'Set up local AI',
      );
      if (action === 'Set up local AI') await this.setup();
      return;
    }
    if (!status.running) {
      const action = await vscode.window.showWarningMessage(
        'Ollama is installed but its local API is offline.',
        'Repair local AI',
      );
      if (action === 'Repair local AI') await this.setup();
      return;
    }
    vscode.window.showInformationMessage(
      `Hawk Local AI is online with ${status.models.length} model${status.models.length === 1 ? '' : 's'}${status.configuredModel ? `; active: ${status.configuredModel}` : ''}.`,
    );
  }
}

async function chooseModel(
  installedModels: string[],
  recommended: LocalAiModelOption,
): Promise<ModelPick | undefined> {
  const picks: ModelPick[] = [];
  const options = [...localAiModelOptions()].sort((left, right) =>
    left.model === recommended.model ? -1 : right.model === recommended.model ? 1 : 0,
  );
  for (const option of options) {
    const installed = installedModels.includes(option.model);
    picks.push({
      label: `${option.model === recommended.model ? '$(star-full)' : '$(chip)'} ${option.title}`,
      description:
        option.model === recommended.model
          ? `${option.model} · recommended${installed ? ' · installed' : ''}`
          : `${option.model}${installed ? ' · installed' : ''}`,
      detail: installed
        ? `${option.detail} Already installed; no download required.`
        : `${option.detail} Approx. ${option.approximateDownloadGb} GB download.`,
      model: option.model,
      ...(installed ? {} : { approximateDownloadGb: option.approximateDownloadGb }),
    });
  }
  for (const model of installedModels) {
    if (options.some((option) => option.model === model)) continue;
    picks.push({
      label: `$(check) ${model}`,
      description: 'already installed',
      detail: 'Use this local Ollama model without another download.',
      model,
    });
  }
  return await vscode.window.showQuickPick(picks, {
    title: 'Hawk Local AI',
    placeHolder: `Choose a local coding model (${Math.round(totalmem() / 1024 ** 3)} GB RAM detected)`,
    ignoreFocusOut: true,
  });
}

async function configureHawkForOllama(model: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('hawk');
  const target = vscode.ConfigurationTarget.Global;
  await configuration.update('preferredProvider', 'ollama', target);
  await configuration.update('preferredModel', model, target);
  await configuration.update('preferredBaseUrl', OLLAMA_API_URL, target);
}

async function fetchInstalledModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_API_URL}/api/tags`, {
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`Ollama API returned ${response.status}.`);
  const body = (await response.json()) as { models?: OllamaApiModel[] };
  return (body.models ?? [])
    .map((model) => model.name ?? model.model ?? '')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function findOllamaExecutable(): string | undefined {
  const candidates = [
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
      : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'ollama.exe')),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function downloadAsset(
  url: string,
  target: string,
  expectedBytes: number,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Hawk-Security-IDE' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama download returned HTTP ${response.status}.`);
    }
    const finalUrl = new URL(response.url);
    if (
      finalUrl.protocol !== 'https:' ||
      (finalUrl.hostname !== 'github.com' &&
        finalUrl.hostname !== 'release-assets.githubusercontent.com')
    ) {
      throw new Error('Ollama download redirected outside GitHub release storage.');
    }
    const contentLength = Number(response.headers.get('content-length') ?? expectedBytes);
    if (
      !Number.isFinite(contentLength) ||
      contentLength <= 0 ||
      contentLength > 2_500 * 1024 ** 2
    ) {
      throw new Error('Ollama download size is outside Hawk safety limits.');
    }
    let received = 0;
    let reported = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        const percent = Math.min(100, Math.floor((received / expectedBytes) * 100));
        if (percent >= reported + 2) {
          reported = percent;
          progress.report({
            message: `Downloading verified Ollama runtime... ${percent}%`,
          });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(target, { mode: 0o700 }),
      );
    } catch (error) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      throw error;
    }
    const info = await stat(target);
    if (info.size !== expectedBytes) {
      throw new Error(`Ollama download size mismatch (${info.size} of ${expectedBytes} bytes).`);
    }
  } finally {
    cancellation.dispose();
  }
}

async function verifiedCachedFile(
  path: string,
  expectedBytes: number,
  expectedHash: string,
): Promise<boolean> {
  try {
    await access(path);
    const info = await stat(path);
    return info.size === expectedBytes && (await sha256File(path)) === expectedHash;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verifyAuthenticode(path: string): Promise<void> {
  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const script =
    '$signature=Get-AuthenticodeSignature -LiteralPath $args[0]; [PSCustomObject]@{Status=$signature.Status.ToString();Subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress';
  const result = await captureProcess(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, path],
    120_000,
  );
  const signature = JSON.parse(result) as { Status?: string; Subject?: string };
  if (signature.Status !== 'Valid' || !/Ollama/i.test(signature.Subject ?? '')) {
    throw new Error(
      `Ollama Authenticode verification failed (${signature.Status ?? 'unknown signer'}).`,
    );
  }
}

async function pullModel(
  executable: string,
  model: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  progress.report({ message: `Downloading ${model}...` });
  const child = spawn(executable, ['pull', model], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const onData = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES);
    const message = output
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (message) progress.report({ message: message.slice(0, 180) });
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const code = await waitForProcess(child, token, 6 * 60 * 60_000);
  if (code !== 0) {
    throw new Error(
      `Ollama could not pull ${model}${output.trim() ? `: ${output.trim().slice(-500)}` : ''}`,
    );
  }
}

async function captureProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES);
  });
  const code = await waitForProcess(child, undefined, timeoutMs);
  if (code !== 0) throw new Error(stderr.trim() || `${command} exited with code ${code}.`);
  return stdout.trim();
}

async function waitForProcess(
  child: ChildProcess,
  token: vscode.CancellationToken | undefined,
  timeoutMs: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancellation?.dispose();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      if (error) reject(error);
      else resolve(code ?? 0);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('The local AI process timed out.'));
    }, timeoutMs);
    const cancellation = token?.onCancellationRequested(() => {
      child.kill();
      finish(new vscode.CancellationError());
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(undefined, code ?? 1));
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
