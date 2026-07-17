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
    const root = await mkdtemp(join(tmpdir(), 'hawk-codeoss-'));
    temporaryRoots.push(root);
    const source = join(root, 'vscode-source');
    const out = join(root, 'hawk-security-ide');
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
    await mkdir(join(source, 'scripts'), { recursive: true });
    await writeFile(join(source, 'scripts', 'code.bat'), '@echo off\ntitle VSCode Dev\n');
    await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored');
    await writeFile(join(extension, 'package.json'), '{"name":"hawk-security-ide"}\n');
    await writeFile(join(extension, 'dist', 'extension.js'), 'module.exports = {};\n');
    await writeFile(overrides, '{"nameShort":"Hawk","applicationName":"hawk"}\n');

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

    await expect(readFile(join(out, 'product.json'), 'utf8')).resolves.toContain('Hawk');
    await expect(readFile(join(out, 'scripts', 'code.bat'), 'utf8')).resolves.toContain(
      'title Hawk Security IDE',
    );
    await expect(
      readFile(join(out, 'extensions', 'hawk-security-ide', 'dist', 'extension.js'), 'utf8'),
    ).resolves.toContain('module.exports');
    await expect(access(join(out, 'node_modules', 'ignored.txt'))).rejects.toThrow();
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-linux/**'",
    );
    await expect(readFile(join(out, 'build', 'gulpfile.vscode.ts'), 'utf8')).resolves.toContain(
      "'**/vendor/audio-capture/*-darwin/**'",
    );
    await expect(access(join(out, 'resources', 'win32', 'code.ico'))).resolves.toBeUndefined();
    await expect(access(join(out, 'resources', 'linux', 'code.png'))).resolves.toBeUndefined();
    await expect(access(join(out, 'resources', 'darwin', 'code.icns'))).resolves.toBeUndefined();
    await expect(access(join(out, '.git', 'HEAD'))).resolves.toBeUndefined();
  });
});
