import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const file = resolve(argument('--file') || '');
const publish = process.argv.includes('--publish');
const validateOnly = process.argv.includes('--validate-only');
if (!argument('--file')) throw new Error('Pass --file with the packaged Hawk VSIX.');
const info = await stat(file);
if (!info.isFile() || info.size <= 0 || info.size > 500_000_000 || !file.endsWith('.vsix')) {
  throw new Error('The Hawk VSIX is missing, empty, too large, or has the wrong extension.');
}

const extensionPackage = JSON.parse(
  await readFile(resolve('extensions/hawk-security-ide/package.json'), 'utf8'),
);
const expectedPublisher = process.env.HAWK_VSCE_PUBLISHER || '';
const publisherMatches =
  Boolean(expectedPublisher) && extensionPackage.publisher === expectedPublisher;
const azureCredential = process.env.HAWK_VSCE_USE_AZURE_CREDENTIAL === '1';
const credentialConfigured = azureCredential || Boolean(process.env.VSCE_PAT);
const missing = [
  !expectedPublisher && 'HAWK_VSCE_PUBLISHER',
  expectedPublisher && !publisherMatches &&
    `package publisher must equal ${expectedPublisher}`,
  !credentialConfigured && 'VSCE_PAT or HAWK_VSCE_USE_AZURE_CREDENTIAL=1',
].filter(Boolean);

if (validateOnly || !publish || missing.length) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ready: missing.length === 0,
        package: file,
        bytes: info.size,
        extension: `${extensionPackage.publisher}.${extensionPackage.name}`,
        authentication: azureCredential ? 'Microsoft Entra ID' : process.env.VSCE_PAT ? 'PAT' : 'missing',
        missing,
        note: 'No Visual Studio Marketplace publication was attempted.',
      },
      null,
      2,
    )}\n`,
  );
  if (publish && missing.length) process.exitCode = 2;
} else {
  const args = [
    'exec',
    '--workspace',
    'hawk-security-ide',
    '--',
    'vsce',
    'publish',
    '--packagePath',
    file,
    '--no-dependencies',
    ...(azureCredential ? ['--azure-credential'] : []),
  ];
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
    });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`vsce exited with code ${code ?? 'unknown'}.`));
    });
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
