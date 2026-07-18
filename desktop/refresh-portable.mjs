#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBrandAssets } from './branding/generate-brand-assets.mjs';
import { sanitizeHawkProduct } from './product-branding.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'Refresh a local Hawk portable build.\n\n' +
      'Usage:\n' +
      '  node desktop/refresh-portable.mjs --target <VSCode-win32-x64> [--extension <path>]\n',
  );
  process.exit(0);
}

const target = requiredPath(args.target, '--target');
const extension = resolve(
  args.extension ?? resolve(projectRoot, 'extensions', 'pentesterflow-ide'),
);
const productPath = resolve(target, 'resources', 'app', 'product.json');
const extensionTarget = resolve(
  target,
  'resources',
  'app',
  'extensions',
  'hawk-security-ide',
);

await assertFile(resolve(target, 'Hawk.exe'), 'a Hawk portable build');
await assertFile(productPath, 'the portable product.json');
await assertFile(resolve(extension, 'package.json'), 'the Hawk extension package');
await assertFile(resolve(extension, 'dist', 'extension.js'), 'the built Hawk extension');
assertInside(target, extensionTarget);

const overrides = JSON.parse(
  await readFile(resolve(scriptDirectory, 'product-overrides.json'), 'utf8'),
);
const product = sanitizeHawkProduct(
  JSON.parse(await readFile(productPath, 'utf8')),
  overrides,
);
delete product.tunnelApplicationName;
delete product.win32TunnelServiceMutex;
delete product.win32TunnelMutex;

await rm(extensionTarget, { recursive: true, force: true });
await mkdir(dirname(extensionTarget), { recursive: true });
await cp(extension, extensionTarget, {
  recursive: true,
  filter: (path) =>
    !['node_modules', 'src', '.vscodeignore'].includes(basename(path)) &&
    !path.endsWith('.vsix'),
});
await writeBrandAssets(resolve(target, 'resources', 'app'));
await refreshNativeWorkbenchBrandAsset(target, extension);
await refreshVisualElementsManifest(target);

for (const name of ['copilot', 'copilot-chat']) {
  const upstreamExtension = resolve(target, 'resources', 'app', 'extensions', name);
  assertInside(target, upstreamExtension);
  await rm(upstreamExtension, { recursive: true, force: true });
}

await refreshIntegrityChecks(target, product);
await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
process.stdout.write(`Refreshed local Hawk portable build at ${target}\n`);

async function refreshIntegrityChecks(portableRoot, product) {
  if (!product.checksums || typeof product.checksums !== 'object') return;
  const outputRoot = resolve(portableRoot, 'resources', 'app', 'out');
  const refreshed = {};
  for (const relativePath of Object.keys(product.checksums)) {
    const filePath = resolve(outputRoot, relativePath);
    assertInside(outputRoot, filePath);
    if (!(await exists(filePath))) continue;
    const bytes = await readFile(filePath);
    refreshed[relativePath] = createHash('sha256')
      .update(bytes)
      .digest('base64')
      .replace(/=+$/, '');
  }
  product.checksums = refreshed;
}

async function refreshVisualElementsManifest(portableRoot) {
  const manifestPath = resolve(portableRoot, 'Hawk.VisualElementsManifest.xml');
  if (!(await exists(manifestPath))) return;
  const original = await readFile(manifestPath, 'utf8');
  const branded = original
    .replace(/BackgroundColor="[^"]*"/, 'BackgroundColor="#080B10"')
    .replace(/ShortDisplayName="[^"]*"/, 'ShortDisplayName="Hawk"');
  await writeFile(manifestPath, branded);
}

async function refreshNativeWorkbenchBrandAsset(portableRoot, extensionRoot) {
  const target = resolve(portableRoot, 'resources', 'app', 'out', 'media', 'code-icon.svg');
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(extensionRoot, 'resources', 'hawk-mark.svg'), target);
}

function parseArgs(argv) {
  const output = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index] ?? '';
    if (flag === '--target') output.target = value();
    else if (flag === '--extension') output.extension = value();
    else if (flag === '--help' || flag === '-h') output.help = true;
    else fail(`unknown flag: ${flag}`);
  }
  return output;
}

function requiredPath(value, flag) {
  if (!value) fail(`${flag} is required`);
  return resolve(value);
}

function assertInside(root, candidate) {
  const prefix = `${resolve(root).toLowerCase()}\\`;
  if (!resolve(candidate).toLowerCase().startsWith(prefix)) {
    fail(`path escapes the portable build: ${candidate}`);
  }
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
  process.stderr.write(`refresh-portable: ${message}\n`);
  process.exit(1);
}
