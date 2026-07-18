import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderBrandPng } from '../desktop/branding/generate-brand-assets.mjs';

const directory = resolve('integrations/browser/icons');
await mkdir(directory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(resolve(directory, `hawk-${size}.png`), renderBrandPng(size));
}
process.stdout.write('Generated Hawk Browser Companion icons.\n');
