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
await assertFile(resolve(extension, 'package.json'), 'the compiled PentesterFlow extension');
await assertFile(resolve(extension, 'dist', 'extension.js'), 'the compiled PentesterFlow extension bundle');
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
await writeFile(resolve(out, 'product.json'), `${JSON.stringify({ ...product, ...overrides }, null, 2)}\n`);
await patchWindowsPackagingTask(resolve(out, 'build', 'gulpfile.vscode.ts'));
await patchDevLaunchers(out);
await writeBrandAssets(out);

const builtinExtension = resolve(out, 'extensions', 'pentesterflow-ide');
await cp(extension, builtinExtension, {
  recursive: true,
  filter: (path) => !['node_modules', 'src', '.vscodeignore'].includes(basename(path)) && !path.endsWith('.vsix'),
});

process.stdout.write(`Prepared branded Code-OSS source at ${out}\n`);
process.stdout.write('Next: npm install, npm run watch, then start the platform script for your OS.\n');

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

async function patchDevLaunchers(root) {
  const batchPath = resolve(root, 'scripts', 'code.bat');
  try {
    const original = await readFile(batchPath, 'utf8');
    await writeFile(batchPath, original.replace('title VSCode Dev', 'title PentesterFlow IDE'));
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
    else if (flag === '--force') output.force = true;
    else if (flag === '--help' || flag === '-h') output.help = true;
    else fail(`unknown flag: ${flag}`);
  }
  return output;
}

function printHelp() {
  process.stdout.write(`Prepare a branded Code-OSS checkout with PentesterFlow IDE built in.\n\nUsage:\n  node desktop/prepare-code-oss.mjs --source <code-oss-checkout> --out <new-directory> [--force]\n`);
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
