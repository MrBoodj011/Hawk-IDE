import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('persists AST/type facts and updates only a changed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-persistent-'));
    roots.push(root);
    const storageRoot = join(root, '.cache');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'service.ts'),
      [
        "import type { Token } from './types.js';",
        'export interface Authorizer { allow(token: Token): Promise<boolean>; }',
        'export async function authorize(token: Token): Promise<boolean> {',
        '  return token.value.startsWith("hawk_");',
        '}',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'types.ts'),
      'export interface Token { value: string; expiresAt: number; }\n',
    );

    const cold = new SemanticWorkspaceIndex(root, { storageRoot });
    const coldStats = await cold.build();
    expect(coldStats.changedFiles).toBe(2);
    expect(coldStats.types).toBeGreaterThan(0);
    expect(cold.search('Authorizer Token Promise')[0]).toMatchObject({
      file: 'src/service.ts',
    });

    const warm = new SemanticWorkspaceIndex(root, { storageRoot });
    const warmStats = await warm.build();
    expect(warmStats.reusedFiles).toBe(2);
    expect(warmStats.changedFiles).toBe(0);

    await writeFile(
      join(root, 'src', 'service.ts'),
      'export class PolicyEngine { denyExpired(expiresAt: number): boolean { return expiresAt < Date.now(); } }\n',
    );
    const incremental = await warm.updateFile('src/service.ts');
    expect(incremental.changedFiles).toBe(1);
    expect(warm.search('PolicyEngine denyExpired')[0]?.file).toBe('src/service.ts');
    expect(warm.search('Authorizer')).toHaveLength(0);
  });

  it('reports a resident budget and keeps the persistent index compact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-memory-'));
    roots.push(root);
    const storageRoot = join(root, '.index-cache');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'memory.ts'),
      Array.from(
        { length: 220 },
        (_, index) => `export const token${index} = 'hawk-${index}';`,
      ).join('\n'),
    );

    const index = new SemanticWorkspaceIndex(root, { storageRoot });
    const stats = await index.build();
    const persisted = await readFile(join(storageRoot, 'semantic-index-v2.json'), 'utf8');

    expect(stats.memory.residentBytes).toBeGreaterThan(stats.bytes);
    expect(stats.memory.residentBytes).toBeLessThanOrEqual(stats.memory.budgetBytes);
    // Normalized text is derived on load; it must not double the durable source
    // payload or make JSON parse transient memory spikes worse.
    expect(persisted).not.toContain('"normalized"');
  });

  it('walks pathologically deep TypeScript ASTs without overflowing the call stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-deep-'));
    roots.push(root);
    await writeFile(
      join(root, 'generated.ts'),
      `export const value = ${'x + '.repeat(18_000)}x;\n`,
    );
    const index = new SemanticWorkspaceIndex(root, { storageRoot: join(root, '.cache') });

    const stats = await index.build();

    expect(stats.files).toBe(1);
    expect(index.search('value generated')).toHaveLength(1);
  });
});
