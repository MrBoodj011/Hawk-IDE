import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('keeps canonical workspace files relative when the selected root is a junction', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'hawk-semantic-linked-root-'));
    roots.push(parent);
    const realRoot = join(parent, 'real-workspace');
    const linkedRoot = join(parent, 'selected-workspace');
    await mkdir(join(realRoot, 'src'), { recursive: true });
    await writeFile(
      join(realRoot, 'src', 'linked.ts'),
      'export function linkedWorkspaceSignal(): boolean { return true; }\n',
    );
    try {
      await symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const index = new SemanticWorkspaceIndex(linkedRoot, {
      storageRoot: join(parent, '.cache'),
    });
    await index.build();

    expect(index.search('linkedWorkspaceSignal')[0]?.file).toBe('src/linked.ts');
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

  it('extracts polyglot symbols, imports, parameter types, and return types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-polyglot-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'policy.py'),
      [
        'from hawk.security.tokens import AccessToken',
        'class AuthorizationPolicy(BasePolicy):',
        '    async def verify_token(self, token: AccessToken) -> Decision:',
        '        return decide(token)',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'PolicyService.java'),
      [
        'import com.hawk.security.AccessToken;',
        'public final class PolicyService {',
        '  public Decision authorize(AccessToken token) { return decide(token); }',
        '}',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'policy.go'),
      [
        'package policy',
        'import "hawk/security/token"',
        'type Decision struct {}',
        'func Authorize(token token.AccessToken) Decision { return decide(token) }',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'policy.rs'),
      [
        'use crate::security::AccessToken;',
        'pub struct Decision {}',
        'pub fn authorize(token: AccessToken) -> Decision { decide(token) }',
      ].join('\n'),
    );

    const index = new SemanticWorkspaceIndex(root, { storageRoot: join(root, '.cache') });
    const stats = await index.build();

    expect(stats.files).toBe(4);
    expect(stats.types).toBeGreaterThanOrEqual(8);
    expect(index.search('verify_token AccessToken Decision')[0]).toMatchObject({
      file: 'src/policy.py',
    });
    expect(index.search('PolicyService authorize AccessToken')[0]).toMatchObject({
      file: 'src/PolicyService.java',
    });
    expect(
      index.search('func Authorize package hawk/security/token', 4).map((item) => item.file),
    ).toContain('src/policy.go');
    expect(
      index.search('use crate::security AccessToken rust function', 4).map((item) => item.file),
    ).toContain('src/policy.rs');
  });

  it('keeps representative semantic chunks from a very large generated file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-semantic-representative-'));
    roots.push(root);
    const lines = Array.from({ length: 5_000 }, (_, index) =>
      index === 4_750
        ? 'export function criticalRecoverySignal(): string { return "recover"; }'
        : `export const generated_${index} = ${index};`,
    );
    await writeFile(join(root, 'generated.ts'), lines.join('\n'));
    const index = new SemanticWorkspaceIndex(root, { storageRoot: join(root, '.cache') });

    const stats = await index.build();

    expect(stats.truncated).toBe(true);
    expect(stats.chunks).toBeLessThanOrEqual(24);
    expect(index.search('criticalRecoverySignal recover')).toHaveLength(1);
  });
});
