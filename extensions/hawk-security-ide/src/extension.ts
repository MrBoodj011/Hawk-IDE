import * as vscode from 'vscode';
import { HawkAgentPanel } from './agentPanel';
import { DaemonClient } from './daemonClient';
import { HawkDebugAgent } from './debugAgent';
import { HawkGitHubAutomation } from './githubAutomation';
import { HawkCodingCore } from './hawkCodingCore';
import { HawkHealthSync } from './hawkHealthSync';
import { HawkLlmProviderSetup } from './llmProviderSetup';
import { HawkLocalAiSetup } from './localAiSetup';
import { HawkReleaseUpdater } from './releaseUpdater';
import { SecurityDashboardProvider } from './securityDashboard';
import { HawkTerminalCapture } from './terminalCapture';

export function activate(context: vscode.ExtensionContext): void {
  const client = new DaemonClient(context.extensionUri, context.secrets);
  const terminalCapture = new HawkTerminalCapture();
  const agentPanel = new HawkAgentPanel(context.extensionUri, client, terminalCapture);
  const debugAgent = new HawkDebugAgent(agentPanel, client);
  const codingCore = new HawkCodingCore(client);
  const localAiSetup = new HawkLocalAiSetup(context, client);
  const llmProviderSetup = new HawkLlmProviderSetup(context, client);
  const releaseUpdater = new HawkReleaseUpdater(context);
  const healthSync = new HawkHealthSync(context.secrets, client);
  const githubAutomation = new HawkGitHubAutomation(context.secrets, client);
  const dashboard = new SecurityDashboardProvider(
    context.extensionUri,
    client,
    healthSync,
    agentPanel,
  );
  context.subscriptions.push(client);
  context.subscriptions.push(terminalCapture);
  context.subscriptions.push(agentPanel);
  context.subscriptions.push(debugAgent);
  context.subscriptions.push(codingCore);
  context.subscriptions.push(localAiSetup);
  context.subscriptions.push(llmProviderSetup);
  context.subscriptions.push(releaseUpdater);
  context.subscriptions.push(githubAutomation);
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
    vscode.commands.registerCommand('hawk.importSecuritySarif', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        const adapters = await client.securityAdapters(workspace);
        const adapter = await vscode.window.showQuickPick(
          adapters.adapters.map((candidate) => ({
            label: candidate.title,
            description: candidate.id,
            detail: candidate.capabilities.join(' · '),
            id: candidate.id,
          })),
          { title: 'Import external security findings', placeHolder: 'Choose the SARIF producer' },
        );
        if (!adapter) return;
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Import SARIF',
          filters: { SARIF: ['sarif', 'json'] },
        });
        const file = files?.[0];
        if (!file) return;
        const bytes = await vscode.workspace.fs.readFile(file);
        if (bytes.byteLength > 5 * 1024 * 1024)
          throw new Error("SARIF file exceeds Hawk's 5 MB limit.");
        const imported = await client.importSecuritySarif(
          workspace,
          adapter.id,
          JSON.parse(new TextDecoder().decode(bytes)),
          file.toString(),
        );
        vscode.window.showInformationMessage(
          `Hawk imported ${imported.findings.length} ${adapter.label} finding(s)${imported.truncated ? ' (truncated)' : ''}.`,
        );
        await dashboard.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk could not import SARIF: ${errorMessage(err)}`);
      }
    }),
    vscode.commands.registerCommand('hawk.runSecurityAdapter', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        const adapters = await client.securityAdapters(workspace);
        const adapter = await vscode.window.showQuickPick(
          adapters.adapters.map((candidate) => ({
            label: candidate.title,
            description: candidate.id,
            detail: `${candidate.execution.executable}: ${candidate.execution.commandHint}`,
            id: candidate.id,
          })),
          { title: 'Run governed security adapter', placeHolder: 'Choose the tool' },
        );
        if (!adapter) return;
        const target = await vscode.window.showInputBox({
          title: `${adapter.label} target`,
          prompt: 'Workspace-relative target (database, directory, URL fixture, or fuzz harness).',
          value: '.',
          validateInput: (value) => (value.trim() ? undefined : 'A target is required.'),
        });
        if (target === undefined) return;
        const argsText = await vscode.window.showInputBox({
          title: `${adapter.label} arguments`,
          prompt:
            'Enter direct arguments separated by spaces. Use ${target} for the mounted target path.',
          value: '${target}',
          ignoreFocusOut: true,
        });
        if (argsText === undefined) return;
        const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
        const image = vscode.workspace
          .getConfiguration('hawk', workspace)
          .get<string>('reproduction.image', 'hawk-worker:local');
        const plan = await client.planSecurityTool(workspace, {
          adapter: adapter.id,
          image,
          target: target.trim(),
          args,
          networkMode: 'none',
        });
        const approval = await vscode.window.showWarningMessage(
          `Run ${adapter.label} in a governed Docker sandbox?`,
          {
            modal: true,
            detail: `${plan.executable} ${plan.args.join(' ')}\nTarget: ${plan.target}\nNetwork: ${plan.networkMode}\nPlan hash: ${plan.planHash.slice(0, 16)}...`,
          },
          'Run adapter',
        );
        if (approval !== 'Run adapter') return;
        const result = await client.runSecurityTool(workspace, plan);
        if (result.status !== 'completed')
          throw new Error('Adapter did not produce a completed SARIF run.');
        vscode.window.showInformationMessage(
          `Hawk ${adapter.label} completed: ${result.findings.length} finding(s) imported.`,
        );
        await dashboard.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk security adapter failed: ${errorMessage(err)}`);
      }
    }),
    vscode.commands.registerCommand('hawk.showIntegrations', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        const response = await client.integrations(workspace);
        const picked = await vscode.window.showQuickPick(
          response.integrations.map((integration) => ({
            label: integration.title,
            description: `${integration.execution} · auth: ${integration.auth}`,
            detail: integration.capabilities.join(' · '),
          })),
          {
            title: 'Hawk governed integrations',
            placeHolder: 'Each action remains scoped and approval-gated.',
          },
        );
        if (picked) vscode.window.showInformationMessage(`${picked.label}: ${picked.detail}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk could not load integrations: ${errorMessage(err)}`);
      }
    }),
    vscode.commands.registerCommand('hawk.syncHawkHealth', async () => {
      await dashboard.syncHawkHealth();
    }),
    vscode.commands.registerCommand('hawk.configureHawkHealthSync', async () => {
      await dashboard.configureHawkHealthSync();
    }),
    vscode.commands.registerCommand('hawk.github.configure', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        await githubAutomation.configure(workspace);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Hawk could not configure GitHub automation: ${errorMessage(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand('hawk.github.issueToPr', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        const result = await githubAutomation.issueToPr(workspace);
        if (result?.pullRequest) {
          vscode.window.showInformationMessage(
            `Hawk opened PR #${result.pullRequest.number}: ${result.pullRequest.url}`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Hawk GitHub workflow failed: ${errorMessage(err)}`);
      }
    }),
    vscode.commands.registerCommand('hawk.github.openPr', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        await githubAutomation.openPullRequest(workspace);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Hawk could not open the pull request: ${errorMessage(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand('hawk.github.reviewPr', async () => {
      const workspace = workspaceUri();
      if (!workspace) return;
      try {
        await githubAutomation.reviewPullRequest(workspace);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Hawk could not review the pull request: ${errorMessage(err)}`,
        );
      }
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
