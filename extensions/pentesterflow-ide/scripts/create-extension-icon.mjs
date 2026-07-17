import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBrandPng } from '../../../desktop/branding/generate-brand-assets.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const iconPath = resolve(scriptDirectory, '..', 'resources', 'hawk-mark.png');
await mkdir(dirname(iconPath), { recursive: true });
await writeFile(iconPath, renderBrandPng(256));
