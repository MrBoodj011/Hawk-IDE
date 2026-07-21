import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '..');
const extensionDevelopmentPath = resolve(root, 'extensions/hawk-security-ide');
const extensionTestsPath = resolve(root, 'scripts/desktop-e2e-extension.mjs');
const workspace = await mkdtemp(join(tmpdir(), 'hawk-desktop-e2e-'));

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    version: process.env.HAWK_VSCODE_VERSION || 'stable',
    launchArgs: [
      workspace,
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: { HAWK_DESKTOP_E2E_WORKSPACE: workspace },
  });
} finally {
  await rm(workspace, { recursive: true, force: true });
}
