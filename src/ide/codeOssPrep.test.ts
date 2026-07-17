import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const prepareScript = resolve(sourceDirectory, '..', '..', 'desktop', 'prepare-code-oss.mjs');

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('prepare-code-oss', () => {
  it('copies a clean Code-OSS source tree, brands product.json, and embeds the compiled extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pentesterflow-codeoss-'));
    temporaryRoots.push(root);
    const source = join(root, 'vscode-source');
    const out = join(root, 'pentesterflow-codeoss');
    const extension = join(root, 'extension');
    const overrides = join(root, 'overrides.json');
    await mkdir(join(source, 'node_modules'), { recursive: true });
    await mkdir(join(source, 'build'), { recursive: true });
    await mkdir(join(extension, 'dist'), { recursive: true });
    await writeFile(
      join(source, 'product.json'),
      '{"nameShort":"Code - OSS","applicationName":"code-oss"}\n',
    );
    await writeFile(
      join(source, 'build', 'gulpfile.vscode.ts'),
      "const deps = [\n  glob('**/*.node', { cwd, ignore: 'extensions/node_modules/@parcel/watcher/**' }),\n];\n",
    );
    await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored');
    await writeFile(join(extension, 'package.json'), '{"name":"pentesterflow-ide"}\n');
    await writeFile(join(extension, 'dist', 'extension.js'), 'module.exports = {};\n');
    await writeFile(
      overrides,
      '{"nameShort":"PentesterFlow IDE","applicationName":"pentesterflow-ide"}\n',
    );

    await execFile(process.execPath, [
      prepareScript,
      '--source',
      source,
      '--out',
      out,
      '--extension',
      extension,
      '--overrides',
      overrides,
    ]);

    await expect(readFile(join(out, 'product.json'), 'utf8')).resolves.toContain(
      'PentesterFlow IDE',
    );
    await expect(
      readFile(join(out, 'extensions', 'pentesterflow-ide', 'dist', 'extension.js'), 'utf8'),
    ).resolves.toContain('module.exports');
    await expect(access(join(out, 'node_modules', 'ignored.txt'))).rejects.toThrow();
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-linux/**'",
    );
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-darwin/**'",
    );
  });
});
