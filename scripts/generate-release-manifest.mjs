import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [directoryArg, tagArg, repositoryArg, commitArg] = process.argv.slice(2);
if (!directoryArg || !tagArg || !repositoryArg) {
  throw new Error(
    'usage: generate-release-manifest.mjs <asset-directory> <tag> <owner/repository>',
  );
}

const directory = resolve(directoryArg);
const tag = tagArg.startsWith('v') ? tagArg : `v${tagArg}`;
const version = tag.slice(1);
const channel = /-(?:beta|rc)(?:[.-]\d+)?$/i.test(tag) ? 'beta' : 'stable';
const files = await filesUnder(directory);
const assets = [];
for (const file of files) {
  if (basename(file) === 'update.json' || basename(file) === 'SHA256SUMS') continue;
  const bytes = await readFile(file);
  assets.push({
    name: basename(file),
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url: `https://github.com/${repositoryArg}/releases/download/${tag}/${encodeURIComponent(basename(file))}`,
  });
}
assets.sort((left, right) => left.name.localeCompare(right.name));
const manifest = {
  schemaVersion: 1,
  product: 'hawk-security-ide',
  version,
  tag,
  channel,
  publishedAt: new Date().toISOString(),
  commit: commitArg && /^[0-9a-f]{40}$/i.test(commitArg) ? commitArg : undefined,
  assets,
};
await writeFile(resolve(directory, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`);

async function filesUnder(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(path)));
    else if (entry.isFile() && (await stat(path)).size > 0) output.push(path);
  }
  return output;
}
