import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const legalAttributionFiles = new Set(['NOTICE', 'extensions/hawk-security-ide/NOTICE']);
const generatedRoots = ['.tmp/', '.vscode-test/', 'artifacts/', 'output/', 'tmp/'];
const forbiddenBrand = new RegExp(['pente', 'sterflow'].join(''), 'i');
const failures = [];

const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})
  .split('\0')
  .filter(Boolean);

for (const relativePath of tracked) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (generatedRoots.some((prefix) => normalized.startsWith(prefix))) continue;
  if (forbiddenBrand.test(normalized)) {
    failures.push(`${normalized}: legacy brand appears in a tracked path`);
    continue;
  }
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) continue;
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  if (!forbiddenBrand.test(text)) continue;
  if (legalAttributionFiles.has(normalized)) continue;
  failures.push(`${normalized}: legacy brand appears outside the legal NOTICE boundary`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const extensionJson = JSON.parse(
  readFileSync(resolve(root, 'extensions', 'hawk-security-ide', 'package.json'), 'utf8'),
);
const productJson = JSON.parse(
  readFileSync(resolve(root, 'desktop', 'product-overrides.json'), 'utf8'),
);

expect(packageJson.name === '@hawk/ide', 'root package must be @hawk/ide');
expect(
  Object.keys(packageJson.bin ?? {}).every((name) => name === 'hawk' || name.startsWith('hawk-')),
  'every published binary must use the hawk name',
);
expect(extensionJson.name === 'hawk-security-ide', 'extension package must be hawk-security-ide');
expect(extensionJson.displayName === 'Hawk Security IDE', 'extension display name must be Hawk');
expect(extensionJson.publisher === 'hawk', 'extension publisher must be hawk');
expect(productJson.nameShort === 'Hawk', 'desktop short name must be Hawk');
expect(productJson.nameLong === 'Hawk Security IDE', 'desktop long name must be Hawk Security IDE');
expect(productJson.applicationName === 'hawk', 'desktop executable identity must be hawk');
expect(productJson.dataFolderName === '.hawk', 'desktop data directory must be .hawk');
expect(
  existsSync(resolve(root, 'extensions', 'hawk-security-ide', 'resources', 'hawk-mark.svg')),
  'canonical Hawk mark is missing',
);

for (const notice of legalAttributionFiles) {
  const text = readFileSync(resolve(root, notice), 'utf8');
  expect(/Apache License, Version 2\.0/i.test(text), `${notice} must retain Apache attribution`);
}

if (failures.length > 0) {
  process.stderr.write(`Hawk branding audit failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Hawk branding audit passed across ${tracked.length} working files; legacy attribution is isolated to NOTICE.\n`,
  );
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}
