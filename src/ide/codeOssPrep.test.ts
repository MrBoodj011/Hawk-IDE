import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const prepareScript = resolve(sourceDirectory, '..', '..', 'desktop', 'prepare-code-oss.mjs');
const productOverrides = resolve(sourceDirectory, '..', '..', 'desktop', 'product-overrides.json');

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('prepare-code-oss', () => {
  it('defines stable Hawk shell identities for every supported Windows architecture', async () => {
    const product = JSON.parse(await readFile(productOverrides, 'utf8')) as {
      win32ContextMenu: Record<string, { clsid: string }>;
      tunnelApplicationName?: string;
    };
    expect(product.tunnelApplicationName).toBeUndefined();
    const identifiers = ['x64', 'arm64'].map((arch) => product.win32ContextMenu[arch]?.clsid);
    expect(identifiers).toHaveLength(2);
    expect(new Set(identifiers).size).toBe(2);
    for (const identifier of identifiers) {
      expect(identifier).toMatch(
        /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/,
      );
    }
  });

  it('copies a clean Code-OSS source tree, brands product.json, and embeds the compiled extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-codeoss-'));
    temporaryRoots.push(root);
    const source = join(root, 'vscode-source');
    const out = join(root, 'hawk-security-ide');
    const extension = join(root, 'extension');
    const overrides = join(root, 'overrides.json');
    await mkdir(join(source, 'node_modules'), { recursive: true });
    await mkdir(join(source, 'build', 'npm'), { recursive: true });
    await mkdir(join(source, 'build', 'linux'), { recursive: true });
    await mkdir(join(source, 'extensions', 'copilot'), { recursive: true });
    await mkdir(join(source, 'src', 'vs', 'workbench', 'browser'), { recursive: true });
    await mkdir(join(source, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser'), {
      recursive: true,
    });
    await mkdir(
      join(source, 'src', 'vs', 'workbench', 'contrib', 'welcomeGettingStarted', 'browser'),
      { recursive: true },
    );
    await mkdir(join(extension, 'dist'), { recursive: true });
    await writeFile(
      join(source, 'product.json'),
      JSON.stringify({
        nameShort: 'Code - OSS',
        applicationName: 'code-oss',
        defaultChatAgent: { extensionId: 'GitHub.copilot' },
        trustedExtensionAuthAccess: { github: ['GitHub.copilot-chat'] },
        tunnelApplicationName: 'code-tunnel-oss',
        win32TunnelServiceMutex: 'code-tunnel-service',
        win32TunnelMutex: 'code-tunnel',
        builtInExtensions: [{ name: 'GitHub.copilot-chat' }, { name: 'ms-vscode.js-debug' }],
      }),
    );
    await writeFile(join(source, 'package.json'), '{"name":"code-oss-dev","version":"0.0.0"}\n');
    await writeFile(
      join(source, 'build', 'gulpfile.vscode.ts'),
      "const deps = [\n  glob('**/*.node', { cwd, ignore: 'extensions/node_modules/@parcel/watcher/**' }),\n];\n" +
        "function prepareCopilotRipgrepShimTask() {\n\t\tconst builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');\n\t\tprepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);\n}\n",
    );
    await writeFile(
      join(source, 'build', 'npm', 'dirs.ts'),
      "export const dirs = [\n\t'',\n\t'extensions/copilot',\n\t'extensions/git',\n];\n",
    );
    await writeFile(
      join(source, 'build', 'gulpfile.vscode.win32.ts'),
      "const definitions = {\n\tTunnelMutex: product.win32TunnelMutex,\n\tTunnelServiceMutex: product.win32TunnelServiceMutex,\n\tTunnelApplicationName: product.tunnelApplicationName,\n};\nif (quality === 'stable' || quality === 'insider') {\n\tconst ctxMenu = (product as { win32ContextMenu?: Record<string, { clsid: string }> }).win32ContextMenu;\n}\n",
    );
    await writeFile(
      join(source, 'build', 'linux', 'dependencies-generator.ts'),
      "const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;\n// Add the tunnel binary.\n\tfiles.push(path.join(buildDir, 'bin', product.tunnelApplicationName));\n",
    );
    await writeFile(
      join(
        source,
        'src',
        'vs',
        'workbench',
        'contrib',
        'welcomeGettingStarted',
        'browser',
        'gettingStarted.contribution.ts',
      ),
      "const settings = {\n\t\t'workbench.welcomePage.walkthroughs.openOnInstall': {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,\n\t\t\tdescription: 'Upstream walkthroughs'\n\t\t},\n\t\t'workbench.startupEditor': {\n\t\t\t'type': 'string',\n\t\t\t'default': 'welcomePage',\n\t\t\tdescription: 'Upstream startup editor'\n\t\t},\n\t\t'workbench.welcomePage.experimentalOnboarding': {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,\n\t\t\tdescription: 'Upstream AI onboarding'\n\t\t}\n};\n",
    );
    await writeFile(
      join(source, 'src', 'vs', 'workbench', 'browser', 'workbench.contribution.ts'),
      "const settings = {\n\t\t'workbench.secondarySideBar.defaultVisibility': {\n\t\t\t'type': 'string',\n\t\t\t'default': 'visibleInWorkspace',\n\t\t\tdescription: 'Upstream sidebar default'\n\t\t}\n};\n",
    );
    await writeFile(
      join(
        source,
        'src',
        'vs',
        'workbench',
        'contrib',
        'chat',
        'browser',
        'chat.shared.contribution.ts',
      ),
      "const settings = {\n\t\t[ChatConfiguration.AIDisabled]: {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: false,\n\t\t\tdescription: 'Upstream AI surfaces'\n\t\t},\n\t\t[ChatConfiguration.TitleBarSignInEnabled]: {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,\n\t\t\tdescription: 'Upstream AI sign in'\n\t\t}\n};\n",
    );
    await mkdir(join(source, 'scripts'), { recursive: true });
    await writeFile(join(source, 'scripts', 'code.bat'), '@echo off\ntitle VSCode Dev\n');
    await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored');
    await writeFile(join(source, 'extensions', 'copilot', 'package.json'), '{"name":"copilot"}\n');
    await writeFile(join(extension, 'package.json'), '{"name":"hawk-security-ide"}\n');
    await writeFile(join(extension, 'dist', 'extension.js'), 'module.exports = {};\n');
    await writeFile(overrides, '{"nameShort":"Hawk","applicationName":"hawk"}\n');

    await execFile(process.execPath, [
      prepareScript,
      '--source',
      source,
      '--out',
      out,
      '--extension',
      extension,
      '--overrides',
      overrides,
      '--version',
      '0.2.0-rc.8',
    ]);

    const product = JSON.parse(await readFile(join(out, 'product.json'), 'utf8')) as {
      nameShort: string;
      defaultChatAgent: { extensionId: string };
      trustedExtensionAuthAccess: { github: string[] };
      tunnelApplicationName?: string;
      win32TunnelServiceMutex?: string;
      win32TunnelMutex?: string;
      builtInExtensions: Array<{ name: string }>;
    };
    expect(product.nameShort).toBe('Hawk');
    expect(product.defaultChatAgent).toEqual({ extensionId: 'GitHub.copilot' });
    expect(product.trustedExtensionAuthAccess).toEqual({ github: ['GitHub.copilot-chat'] });
    expect(product.tunnelApplicationName).toBeUndefined();
    expect(product.win32TunnelServiceMutex).toBeUndefined();
    expect(product.win32TunnelMutex).toBeUndefined();
    expect(product.builtInExtensions).toEqual([{ name: 'ms-vscode.js-debug' }]);
    await expect(readFile(join(out, 'package.json'), 'utf8')).resolves.toContain(
      '"version": "0.2.0"',
    );
    await expect(readFile(join(out, 'scripts', 'code.bat'), 'utf8')).resolves.toContain(
      'title Hawk Security IDE',
    );
    await expect(
      readFile(join(out, 'extensions', 'hawk-security-ide', 'dist', 'extension.js'), 'utf8'),
    ).resolves.toContain('module.exports');
    await expect(access(join(out, 'node_modules', 'ignored.txt'))).rejects.toThrow();
    await expect(access(join(out, 'extensions', 'copilot', 'package.json'))).rejects.toThrow();
    await expect(readFile(join(out, 'build', 'npm', 'dirs.ts'), 'utf8')).resolves.toBe(
      "export const dirs = [\n\t'',\n\t'extensions/git',\n];\n",
    );
    await expect(
      readFile(join(out, 'build', 'linux', 'dependencies-generator.ts'), 'utf8'),
    ).resolves.toContain('if (product.tunnelApplicationName)');
    await expect(
      readFile(join(out, 'build', 'linux', 'dependencies-generator.ts'), 'utf8'),
    ).resolves.toContain('const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = false;');
    const windowsSetupSource = await readFile(
      join(out, 'build', 'gulpfile.vscode.win32.ts'),
      'utf8',
    );
    expect(windowsSetupSource).toContain(
      'TunnelApplicationName: product.tunnelApplicationName ?? `${product.applicationName}-tunnel-disabled`',
    );
    const gettingStartedSource = await readFile(
      join(
        out,
        'src',
        'vs',
        'workbench',
        'contrib',
        'welcomeGettingStarted',
        'browser',
        'gettingStarted.contribution.ts',
      ),
      'utf8',
    );
    expect(gettingStartedSource).toContain('default: false,');
    expect(gettingStartedSource).toContain(
      "'workbench.welcomePage.walkthroughs.openOnInstall': {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: false,",
    );
    expect(gettingStartedSource).toContain("'default': 'none',");
    await expect(
      readFile(join(out, 'src', 'vs', 'workbench', 'browser', 'workbench.contribution.ts'), 'utf8'),
    ).resolves.toContain("'default': 'hidden',");
    const chatConfigurationSource = await readFile(
      join(
        out,
        'src',
        'vs',
        'workbench',
        'contrib',
        'chat',
        'browser',
        'chat.shared.contribution.ts',
      ),
      'utf8',
    );
    expect(chatConfigurationSource).toContain(
      "[ChatConfiguration.AIDisabled]: {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,",
    );
    expect(chatConfigurationSource).toContain(
      "[ChatConfiguration.TitleBarSignInEnabled]: {\n\t\t\ttype: 'boolean',\n\t\t\tdefault: false,",
    );
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-linux/**'",
    );
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-darwin/**'",
    );
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      'if (!fs.existsSync(builtInCopilotExtensionDir)) {\n\t\t\treturn;',
    );
    await expect(access(join(out, 'resources', 'win32', 'code.ico'))).resolves.toBeUndefined();
    await expect(access(join(out, 'resources', 'linux', 'code.png'))).resolves.toBeUndefined();
    await expect(access(join(out, 'resources', 'darwin', 'code.icns'))).resolves.toBeUndefined();
    await expect(access(join(out, '.git', 'HEAD'))).resolves.toBeUndefined();
  });
});
