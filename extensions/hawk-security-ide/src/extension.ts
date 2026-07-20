import * as vscode from 'vscode';
import { HawkAgentPanel } from './agentPanel';
import { DaemonClient } from './daemonClient';
import { HawkDebugAgent } from './debugAgent';
import { HawkCodingCore } from './hawkCodingCore';
import { HawkHealthSync } from './hawkHealthSync';
import { HawkLocalAiSetup } from './localAiSetup';
import { HawkReleaseUpdater } from './releaseUpdater';
import { SecurityDashboardProvider } from './securityDashboard';

export function activate(context: vscode.ExtensionContext): void {
  const client = new DaemonClient(context.extensionUri);
  const agentPanel = new HawkAgentPanel(context.extensionUri, client);
  const debugAgent = new HawkDebugAgent(agentPanel, client);
  const codingCore = new HawkCodingCore(client);
  const localAiSetup = new HawkLocalAiSetup(context, client);
  const releaseUpdater = new HawkReleaseUpdater(context);
  const healthSync = new HawkHealthSync(context.secrets, client);
  const dashboard = new SecurityDashboardProvider(
    context.extensionUri,
    client,
    healthSync,
    agentPanel,
  );
  context.subscriptions.push(client);
  context.subscriptions.push(agentPanel);
  context.subscriptions.push(debugAgent);
  context.subscriptions.push(codingCore);
  context.subscriptions.push(localAiSetup);
  context.subscriptions.push(releaseUpdater);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hawk.securityDashboard', dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('hawk.startDaemon', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        await client.start(workspace);
        vscode.window.showInformationMessage('Hawk local control plane is ready.');
        await dashboard.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk could not start: ${errorMessage(err)}`);
      }
    }),
    vscode.commands.registerCommand('hawk.indexWorkspace', async () => {
      await dashboard.indexWorkspace();
    }),
    vscode.commands.registerCommand('hawk.openAgent', () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Trust this workspace before launching the Hawk AI agent.',
        );
        return;
      }
      agentPanel.open(workspace);
    }),
    vscode.commands.registerCommand('hawk.runWorkspaceScan', async () => {
      await dashboard.runApprovedWorkspaceScan();
    }),
    vscode.commands.registerCommand('hawk.syncHawkHealth', async () => {
      await dashboard.syncHawkHealth();
    }),
    vscode.commands.registerCommand('hawk.configureHawkHealthSync', async () => {
      await dashboard.configureHawkHealthSync();
    }),
    vscode.commands.registerCommand('hawk.openSecurityDashboard', async () => {
      dashboard.openMissionControl();
    }),
    vscode.commands.registerCommand('hawk.pairCapture', async () => {
      await dashboard.pairCaptureCompanions();
    }),
    vscode.commands.registerCommand('hawk.planIdentityReplay', async () => {
      await dashboard.planIdentityReplay();
    }),
    vscode.commands.registerCommand('hawk.buildEvidencePack', async () => {
      await dashboard.buildEvidencePack();
    }),
    vscode.commands.registerCommand('hawk.planGovernedMission', async () => {
      await dashboard.planGovernedMission();
    }),
    vscode.commands.registerCommand('hawk.exportDebugBundle', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      const approval = await vscode.window.showWarningMessage(
        'Export a sanitized Hawk debug bundle with bounded request metrics and runtime metadata?',
        { modal: true },
        'Export bundle',
      );
      if (approval !== 'Export bundle') return;
      try {
        const bundle = await client.buildDebugBundle(workspace);
        const action = await vscode.window.showInformationMessage(
          `Hawk debug bundle created (${Math.ceil(bundle.bytes / 1024)} KiB, SHA-256 ${bundle.sha256.slice(0, 12)}...).`,
          'Reveal file',
        );
        if (action === 'Reveal file') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(bundle.path));
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk could not export diagnostics: ${errorMessage(err)}`);
      }
    }),
  );

  const closeLegacyAuxiliaryBar = () => {
    void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  };
  setTimeout(closeLegacyAuxiliaryBar, 250);
  setTimeout(() => {
    closeLegacyAuxiliaryBar();
    const openOnStartup = vscode.workspace
      .getConfiguration('hawk')
      .get<boolean>('openMissionControlOnStartup', true);
    if (openOnStartup) dashboard.openMissionControl();
    codingCore.warmWorkspace();
  }, 900);
  setTimeout(() => {
    void localAiSetup.offerFirstRun();
  }, 3_500);
}

export function deactivate(): void {
  // DaemonClient is disposed through ExtensionContext subscriptions.
}

function workspaceUri(): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspace) vscode.window.showWarningMessage('Open a folder before using Hawk Security IDE.');
  return workspace;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
