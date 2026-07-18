#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { writeBrandAssets } from './branding/generate-brand-assets.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const defaultExtension = resolve(projectRoot, 'extensions', 'pentesterflow-ide');
const defaultOverrides = resolve(scriptDirectory, 'product-overrides.json');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const source = requiredPath(args.source, '--source');
const out = requiredPath(args.out, '--out');
const extension = resolve(args.extension ?? defaultExtension);
const overridesPath = resolve(args.overrides ?? defaultOverrides);

if (source === out) fail('--source and --out must be different directories');
if (out.startsWith(`${source}\\`) || out.startsWith(`${source}/`)) {
  fail('--out must not be inside the Code-OSS source directory');
}

await assertFile(resolve(source, 'product.json'), 'a Code-OSS checkout (missing product.json)');
await assertFile(resolve(extension, 'package.json'), 'the compiled Hawk extension');
await assertFile(resolve(extension, 'dist', 'extension.js'), 'the compiled Hawk extension bundle');
await assertFile(overridesPath, 'product overrides');

if (await exists(out)) {
  if (!args.force) fail(`output already exists: ${out}; pass --force to replace it`);
  await rm(out, { recursive: true, force: true });
}

await mkdir(dirname(out), { recursive: true });
await cp(source, out, {
  recursive: true,
  filter: (path) => !['.git', 'node_modules', 'out', '.build'].includes(basename(path)),
});
ensureBuildGitRepository(out);

const [productText, overridesText] = await Promise.all([
  readFile(resolve(out, 'product.json'), 'utf8'),
  readFile(overridesPath, 'utf8'),
]);
const product = JSON.parse(productText);
const overrides = JSON.parse(overridesText);
const brandedProduct = filterUpstreamAiDownloads({
  ...product,
  ...overrides,
  ...(args.quality ? { quality: args.quality } : {}),
  ...(args.updateUrl ? { updateUrl: args.updateUrl } : {}),
});
await writeFile(resolve(out, 'product.json'), `${JSON.stringify(brandedProduct, null, 2)}\n`);
if (args.version) await stampProductVersion(out, args.version);
await patchWindowsPackagingTask(resolve(out, 'build', 'gulpfile.vscode.ts'));
await patchRemovedCopilotPackagingTask(resolve(out, 'build', 'gulpfile.vscode.ts'));
await patchWindowsSetupContextMenu(resolve(out, 'build', 'gulpfile.vscode.win32.ts'));
const gettingStartedConfiguration = resolve(
  out,
  'src',
  'vs',
  'workbench',
  'contrib',
  'welcomeGettingStarted',
  'browser',
  'gettingStarted.contribution.ts',
);
await patchSettingDefault(
  gettingStartedConfiguration,
  "'workbench.welcomePage.experimentalOnboarding':",
  'default: true,',
  'default: false,',
);
await patchSettingDefault(
  gettingStartedConfiguration,
  "'workbench.welcomePage.walkthroughs.openOnInstall':",
  'default: true,',
  'default: false,',
);
await patchSettingDefault(
  gettingStartedConfiguration,
  "'workbench.startupEditor':",
  "'default': 'welcomePage',",
  "'default': 'none',",
);
await patchSettingDefault(
  resolve(out, 'src', 'vs', 'workbench', 'browser', 'workbench.contribution.ts'),
  "'workbench.secondarySideBar.defaultVisibility':",
  "'default': 'visibleInWorkspace',",
  "'default': 'hidden',",
);
const chatConfiguration = resolve(
  out,
  'src',
  'vs',
  'workbench',
  'contrib',
  'chat',
  'browser',
  'chat.shared.contribution.ts',
);
await patchSettingDefault(
  chatConfiguration,
  '[ChatConfiguration.AIDisabled]:',
  'default: false,',
  'default: true,',
);
await patchSettingDefault(
  chatConfiguration,
  '[ChatConfiguration.TitleBarSignInEnabled]:',
  'default: true,',
  'default: false,',
);
await patchDevLaunchers(out);
await writeBrandAssets(out);
await removeUpstreamAiExtensions(out);

const builtinExtension = resolve(out, 'extensions', 'hawk-security-ide');
await cp(extension, builtinExtension, {
  recursive: true,
  filter: (path) => !['node_modules', 'src', '.vscodeignore'].includes(basename(path)) && !path.endsWith('.vsix'),
});

process.stdout.write(`Prepared Hawk Security IDE source at ${out}\n`);
process.stdout.write('Next: npm install, npm run watch, then start the platform script for your OS.\n');

function filterUpstreamAiDownloads(product) {
  const branded = { ...product };
  if (Array.isArray(branded.builtInExtensions)) {
    branded.builtInExtensions = branded.builtInExtensions.filter(
      (extension) => !String(extension?.name ?? '').toLowerCase().includes('copilot'),
    );
  }
  return branded;
}

async function removeUpstreamAiExtensions(root) {
  const installDirectories = resolve(root, 'build', 'npm', 'dirs.ts');
  if (await exists(installDirectories)) {
    const original = await readFile(installDirectories, 'utf8');
    const filtered = original.replace(
      /^\s*['"]extensions\/(?:copilot|copilot-chat)['"],?\r?\n/gm,
      '',
    );
    if (filtered !== original) {
      await writeFile(installDirectories, filtered);
    }
  }

  await Promise.all(
    ['copilot', 'copilot-chat'].map((name) =>
      rm(resolve(root, 'extensions', name), { recursive: true, force: true }),
    ),
  );
}

async function patchWindowsPackagingTask(gulpfilePath) {
  const original = await readFile(gulpfilePath, 'utf8');
  const target = "glob('**/*.node', { cwd, ignore: 'extensions/node_modules/@parcel/watcher/**' }),";
  const replacement = `glob('**/*.node', {
\t\t\tcwd,
\t\t\tignore: [
\t\t\t\t'extensions/node_modules/@parcel/watcher/**',
\t\t\t\t'**/vendor/audio-capture/*-linux/**',
\t\t\t\t'**/vendor/audio-capture/*-darwin/**'
\t\t\t]
\t\t}),`;

  if (original.includes(replacement)) return;
  if (!original.includes(target)) {
    fail(`could not apply the Windows packaging compatibility patch: ${gulpfilePath}`);
  }

  await writeFile(gulpfilePath, original.replace(target, replacement));
}

async function patchRemovedCopilotPackagingTask(gulpfilePath) {
  const original = await readFile(gulpfilePath, 'utf8');
  const target =
    "\t\tconst builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');\n" +
    '\t\tprepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);';
  const replacement =
    "\t\tconst builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');\n" +
    '\t\tif (!fs.existsSync(builtInCopilotExtensionDir)) {\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n' +
    '\t\tprepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);';

  if (original.includes(replacement)) return;
  if (!original.includes(target)) {
    fail(`could not guard the removed Copilot packaging task: ${gulpfilePath}`);
  }
  await writeFile(gulpfilePath, original.replace(target, replacement));
}

async function patchWindowsSetupContextMenu(gulpfilePath) {
  if (!(await exists(gulpfilePath))) return;
  const original = await readFile(gulpfilePath, 'utf8');
  const condition = "if (quality === 'stable' || quality === 'insider') {";
  const contextMenu =
    "const ctxMenu = (product as { win32ContextMenu?: Record<string, { clsid: string }> }).win32ContextMenu;";
  const guarded =
    "if ((quality === 'stable' || quality === 'insider') && ctxMenu?.[arch]) {";
  if (original.includes(guarded)) return;
  if (!original.includes(condition) || !original.includes(contextMenu)) {
    fail(`could not apply the Windows setup context-menu guard: ${gulpfilePath}`);
  }
  const withDeclaration = original.replace(
    condition,
    `${contextMenu}\n\t\t${guarded}`,
  );
  const declarationAfterCondition = withDeclaration.indexOf(contextMenu, withDeclaration.indexOf(guarded));
  if (declarationAfterCondition < 0) {
    fail(`could not remove the duplicate Windows context-menu declaration: ${gulpfilePath}`);
  }
  await writeFile(
    gulpfilePath,
    `${withDeclaration.slice(0, declarationAfterCondition)}${withDeclaration.slice(
      declarationAfterCondition + contextMenu.length,
    )}`,
  );
}

async function patchSettingDefault(configurationPath, setting, currentDefault, hawkDefault) {
  const original = await readFile(configurationPath, 'utf8');
  const settingIndex = original.indexOf(setting);
  if (settingIndex < 0) {
    fail(`could not find the upstream setting ${setting}: ${configurationPath}`);
  }

  const blockEnd = original.indexOf('\n\t\t}', settingIndex);
  if (blockEnd < 0) {
    fail(`could not identify the upstream setting block ${setting}: ${configurationPath}`);
  }

  const block = original.slice(settingIndex, blockEnd);
  const patchedBlock = block.replace(currentDefault, hawkDefault);
  if (block === patchedBlock && !block.includes(hawkDefault)) {
    fail(`could not apply the Hawk default for ${setting}: ${configurationPath}`);
  }

  await writeFile(
    configurationPath,
    `${original.slice(0, settingIndex)}${patchedBlock}${original.slice(blockEnd)}`,
  );
}

async function patchDevLaunchers(root) {
  const batchPath = resolve(root, 'scripts', 'code.bat');
  try {
    const original = await readFile(batchPath, 'utf8');
    await writeFile(batchPath, original.replace('title VSCode Dev', 'title Hawk Security IDE'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function ensureBuildGitRepository(root) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
  } catch (error) {
    if (error?.code === 'ENOENT') fail('Git is required to prepare a Code-OSS build source');
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['config', 'user.name', 'Hawk Build'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'build@hawk.local'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'Hawk build source'], {
      cwd: root,
      stdio: 'ignore',
    });
  }
}

function parseArgs(argv) {
  const output = { help: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index] ?? '';
    if (flag === '--source') output.source = value();
    else if (flag === '--out') output.out = value();
    else if (flag === '--extension') output.extension = value();
    else if (flag === '--overrides') output.overrides = value();
    else if (flag === '--version') output.version = value();
    else if (flag === '--quality') output.quality = value();
    else if (flag === '--update-url') output.updateUrl = value();
    else if (flag === '--force') output.force = true;
    else if (flag === '--help' || flag === '-h') output.help = true;
    else fail(`unknown flag: ${flag}`);
  }
  return output;
}

function printHelp() {
  process.stdout.write(`Prepare a branded Code-OSS checkout with Hawk Security IDE built in.\n\nUsage:\n  node desktop/prepare-code-oss.mjs --source <code-oss-checkout> --out <new-directory> [--version <semver>] [--quality stable] [--update-url <url>] [--force]\n`);
}

async function stampProductVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`--version must be a semantic version: ${version}`);
  }
  const packagePath = resolve(root, 'package.json');
  const packageJSON = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJSON.version = version;
  await writeFile(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);
}

function requiredPath(value, flag) {
  if (!value) fail(`${flag} is required`);
  return resolve(value);
}

async function assertFile(path, label) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    fail(`could not find ${label}: ${path}`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`prepare-code-oss: ${message}\n`);
  process.exit(1);
}
