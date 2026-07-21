import * as vscode from 'vscode';
import type { DaemonClient } from './daemonClient';
import {
  hawkLlmProvider,
  hawkLlmProviders,
  llmSecretStorageKey,
  validateProviderBaseUrl,
} from './llmProviderPolicy';

export class HawkLlmProviderSetup implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: DaemonClient,
  ) {
    this.disposables = [
      vscode.commands.registerCommand('hawk.configureLLMProvider', async () => {
        await this.configure();
      }),
      vscode.commands.registerCommand('hawk.clearLLMKey', async () => {
        await this.clearCurrentKey();
      }),
      vscode.commands.registerCommand('hawk.showLLMStatus', async () => {
        await this.showStatus();
      }),
    ];
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async configure(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('hawk');
    const currentProvider = configuration.get<string>('preferredProvider', 'ollama');
    const choice = await vscode.window.showQuickPick(
      hawkLlmProviders().map((provider) => ({
        label: provider.label,
        description: provider.id === currentProvider ? 'Current' : undefined,
        detail: provider.detail,
        provider,
      })),
      {
        title: 'Hawk AI Provider',
        placeHolder: 'Choose the model provider used by Hawk Agent and Hawk Tab',
        ignoreFocusOut: true,
      },
    );
    if (!choice) return;
    const provider = choice.provider;
    const existingModel = configuration.get<string>('preferredModel', '');
    const model = await vscode.window.showInputBox({
      title: `${provider.label}: model`,
      prompt: 'Enter a model ID, or leave empty to use the provider default.',
      value: provider.id === currentProvider ? existingModel : '',
      ignoreFocusOut: true,
    });
    if (model === undefined) return;

    const existingBaseUrl = configuration.get<string>('preferredBaseUrl', '');
    const baseUrlInput = await vscode.window.showInputBox({
      title: `${provider.label}: endpoint`,
      prompt:
        provider.id === 'openai-compat'
          ? 'Required HTTPS or loopback endpoint.'
          : 'Optional custom endpoint. Remote endpoints must use HTTPS.',
      value:
        provider.id === currentProvider
          ? existingBaseUrl || provider.defaultBaseUrl
          : provider.defaultBaseUrl,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          validateProviderBaseUrl(provider, value);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
      },
    });
    if (baseUrlInput === undefined) return;
    const baseUrl = validateProviderBaseUrl(provider, baseUrlInput);

    if (!provider.local) {
      const existingKey = await this.context.secrets.get(llmSecretStorageKey(provider.id));
      const apiKey = await vscode.window.showInputBox({
        title: `${provider.label}: API key`,
        prompt: existingKey
          ? 'A key is already stored. Leave empty to keep it, or enter a replacement.'
          : provider.apiKeyRequired
            ? 'Enter your API key. It is stored only in the OS-backed Hawk secret vault.'
            : 'Optional API key. It is stored only in the OS-backed Hawk secret vault.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          provider.apiKeyRequired && !existingKey && value.trim().length < 8
            ? 'This provider requires an API key.'
            : undefined,
      });
      if (apiKey === undefined) return;
      if (apiKey.trim()) {
        await this.context.secrets.store(llmSecretStorageKey(provider.id), apiKey.trim());
      }
    }

    await Promise.all([
      configuration.update('preferredProvider', provider.id, vscode.ConfigurationTarget.Global),
      configuration.update('preferredModel', model.trim(), vscode.ConfigurationTarget.Global),
      configuration.update('preferredBaseUrl', baseUrl, vscode.ConfigurationTarget.Global),
    ]);
    await this.restartIfOpen();
    vscode.window.showInformationMessage(
      `${provider.label} is now active for Hawk Agent and Hawk Tab. No API key was written to settings or the workspace.`,
    );
  }

  private async clearCurrentKey(): Promise<void> {
    const providerId = vscode.workspace
      .getConfiguration('hawk')
      .get<string>('preferredProvider', '')
      .trim();
    const provider = hawkLlmProvider(providerId);
    if (!provider || provider.local) {
      vscode.window.showInformationMessage('The current Hawk provider has no stored cloud key.');
      return;
    }
    const approval = await vscode.window.showWarningMessage(
      `Remove the stored ${provider.label} key from this machine?`,
      { modal: true },
      'Remove key',
    );
    if (approval !== 'Remove key') return;
    await this.context.secrets.delete(llmSecretStorageKey(provider.id));
    await this.restartIfOpen();
    vscode.window.showInformationMessage(`${provider.label} key removed from Hawk secret storage.`);
  }

  private async showStatus(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('hawk');
    const providerId = configuration.get<string>('preferredProvider', '').trim() || 'ollama';
    const provider = hawkLlmProvider(providerId);
    if (!provider) {
      vscode.window.showWarningMessage(`Hawk has an unsupported provider configured: ${providerId}`);
      return;
    }
    const hasKey = provider.local
      ? false
      : Boolean(await this.context.secrets.get(llmSecretStorageKey(provider.id)));
    const model = configuration.get<string>('preferredModel', '').trim() || 'provider default';
    const endpoint =
      configuration.get<string>('preferredBaseUrl', '').trim() ||
      provider.defaultBaseUrl ||
      'provider default';
    vscode.window.showInformationMessage(
      `Hawk AI: ${provider.label}; model ${model}; endpoint ${endpoint}; credential ${provider.local ? 'not required' : hasKey ? 'stored securely' : 'missing'}.`,
      'Configure',
    ).then((action) => {
      if (action === 'Configure') void vscode.commands.executeCommand('hawk.configureLLMProvider');
    });
  }

  private async restartIfOpen(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspace || !vscode.workspace.isTrusted) return;
    await this.client.restart(workspace);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
