import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve(
  argument('--output') || '.hawk/validation/store-publication.json',
);
const stores = {
  chrome: listing('--chrome', 'chromewebstore.google.com'),
  vscode: listing('--vscode', 'marketplace.visualstudio.com'),
  burp: listing('--burp', 'portswigger.net'),
};
const evidence = {
  schema: 1,
  product: 'Hawk Security IDE',
  recordedAt: new Date().toISOString(),
  stores,
  note: 'Owner-recorded URLs are release-gate evidence; each store remains the authority for publication status.',
};
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const temporary = `${output}.${randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
await rename(temporary, output);
process.stdout.write(`${JSON.stringify({ output, ...evidence }, null, 2)}\n`);

function listing(flag, host) {
  const value = argument(flag);
  if (!value) throw new Error(`${flag} is required.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password) {
    throw new Error(`${flag} must be an HTTPS listing on ${host}.`);
  }
  return { status: 'published', url: url.toString() };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
