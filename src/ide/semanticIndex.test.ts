import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SemanticWorkspaceIndex } from './semanticIndex.js';

describe('SemanticWorkspaceIndex', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('indexes symbols and ranks the matching implementation above unrelated code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'auth.ts'),
      'export function verifyAccessToken(token: string) {\\n  return token.startsWith("hawk_");\\n}\\n',
    );
    await writeFile(
      join(root, 'src', 'math.ts'),
      'export function add(left: number, right: number) { return left + right; }\\n',
    );

    const index = new SemanticWorkspaceIndex(root);
    const stats = await index.build();
    const results = index.search('where is access token verification implemented?', 5);

    expect(stats.files).toBe(2);
    expect(stats.chunks).toBe(2);
    expect(results[0]?.file).toBe('src/auth.ts');
    expect(results[0]?.symbols).toContain('verifyAccessToken');
  });

  it('skips dependency directories and supports lazy builds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-'));
    roots.push(root);
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'ignored', 'index.ts'), 'const poisoned = true;\\n');
    await writeFile(join(root, 'app', 'main.ts'), 'class HawkRuntime {}\\n');

    const index = new SemanticWorkspaceIndex(root);
    const stats = await index.ensureBuilt();

    expect(stats.files).toBe(1);
    expect(index.search('HawkRuntime')).toHaveLength(1);
    expect(index.search('poisoned')).toHaveLength(0);
  });
});
