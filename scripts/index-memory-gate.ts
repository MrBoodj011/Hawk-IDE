import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  INDEX_MEMORY_BUDGET_BYTES,
  runCodingCoreBenchmark,
} from '../src/ide/codingBenchmark.js';
import { SemanticWorkspaceIndex } from '../src/ide/semanticIndex.js';

const workspaceRoot = resolve(argument('--root') || '.');
const storageRoot = await mkdtemp(join(tmpdir(), 'hawk-index-memory-'));

try {
  const benchmark = await runCodingCoreBenchmark(
    new SemanticWorkspaceIndex(workspaceRoot, { storageRoot }),
  );
  const report = {
    schema: 1,
    workspaceRoot,
    budgetBytes: INDEX_MEMORY_BUDGET_BYTES,
    budgetMiB: INDEX_MEMORY_BUDGET_BYTES / 1024 / 1024,
    passed: benchmark.gates.rssUnder500Mb,
    benchmark,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.stderr.write(
      `Hawk index memory gate failed: peak RSS ${formatMiB(
        benchmark.process.peakRssBytes,
      )} MiB must stay below ${formatMiB(INDEX_MEMORY_BUDGET_BYTES)} MiB.\n`,
    );
    process.exitCode = 1;
  }
} finally {
  await rm(storageRoot, { recursive: true, force: true });
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
