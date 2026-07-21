import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run() {
  const extension = vscode.extensions.getExtension('hawk.hawk-security-ide');
  assert.ok(extension, 'Hawk extension must be discoverable by the real extension host');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'hawk.openSecurityDashboard',
    'hawk.openAgent',
    'hawk.indexWorkspace',
    'hawk.exportDebugBundle',
  ]) {
    assert.ok(commands.includes(command), `missing registered command: ${command}`);
  }
  assert.equal(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(),
    process.env.HAWK_DESKTOP_E2E_WORKSPACE?.toLowerCase(),
  );

  // Exercise the actual desktop UI command path. This creates a live Webview
  // panel inside the VS Code host, not a mocked API surface.
  const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
  await vscode.commands.executeCommand('hawk.openSecurityDashboard');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
  assert.ok(after > before, 'Mission Control command should open a desktop Webview panel');
}

export function teardown() {}
