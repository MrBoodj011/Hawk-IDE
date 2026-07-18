#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const version = process.argv[2]?.trim().replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write('Usage: node desktop/stamp-extension-version.mjs <semver>\n');
  process.exit(1);
}

const packagePath = resolve(projectRoot, 'extensions', 'pentesterflow-ide', 'package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
packageJson.version = version;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
process.stdout.write(`Stamped Hawk extension version ${version}\n`);
