import { unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const legacyOutput = resolve(scriptsDirectory, '..', 'dist', 'ide-daemon.mjs');
try {
  await unlink(legacyOutput);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await build({
  entryPoints: [resolve(scriptsDirectory, '..', '..', '..', 'src', 'ide', 'daemonCli.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: resolve(scriptsDirectory, '..', 'dist', 'ide-daemon.cjs'),
  banner: { js: '#!/usr/bin/env node' },
});

await build({
  entryPoints: [resolve(scriptsDirectory, '..', '..', '..', 'src', 'ide', 'mcpServer.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: resolve(scriptsDirectory, '..', 'dist', 'ide-mcp.cjs'),
  banner: { js: '#!/usr/bin/env node' },
});
