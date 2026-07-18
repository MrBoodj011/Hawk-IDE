import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodingCoreBenchmark } from './codingBenchmark.js';
import { SemanticWorkspaceIndex } from './semanticIndex.js';

describe('runCodingCoreBenchmark', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports bounded index, search, completion, and memory gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-benchmark-'));
    roots.push(root);
    await writeFile(
      join(root, 'auth.ts'),
      'export function validateAccessToken(token: string) { return Boolean(token); }\n',
    );
    const benchmark = await runCodingCoreBenchmark(
      new SemanticWorkspaceIndex(root),
      [100, 200, 300],
    );

    expect(benchmark.semanticIndex.files).toBe(1);
    expect(benchmark.search.samples).toBe(25);
    expect(benchmark.completion).toMatchObject({ samples: 3, p50Ms: 200, p95Ms: 300 });
    expect(benchmark.gates.indexUnderFiveSeconds).toBe(true);
    expect(benchmark.gates.searchP95UnderFiftyMs).toBe(true);
  });
});
