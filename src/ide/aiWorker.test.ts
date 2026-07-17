import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IsolatedFileDeleteTool } from './aiWorker.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('IsolatedFileDeleteTool', () => {
  it('deletes a single file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-delete-'));
    temporaryRoots.push(root);
    const path = join(root, 'obsolete.txt');
    await writeFile(path, 'obsolete\n', 'utf8');

    const result = await new IsolatedFileDeleteTool().run({ path });

    expect(result).toContain('deleted');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses recursive directory deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-delete-dir-'));
    temporaryRoots.push(root);

    await expect(new IsolatedFileDeleteTool().run({ path: root })).rejects.toThrow(
      'cannot delete directories',
    );
  });
});
