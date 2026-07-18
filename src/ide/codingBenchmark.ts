import type { SemanticIndexStats, SemanticWorkspaceIndex } from './semanticIndex.js';

export interface CodingCoreBenchmark {
  measuredAt: string;
  semanticIndex: SemanticIndexStats;
  search: {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    resultsReturned: number;
  };
  completion: {
    samples: number;
    p50Ms?: number;
    p95Ms?: number;
  };
  process: {
    rssBytes: number;
    heapUsedBytes: number;
  };
  gates: {
    indexUnderFiveSeconds: boolean;
    searchP95UnderFiftyMs: boolean;
    rssUnderOneGigabyte: boolean;
  };
}

const BENCHMARK_QUERIES = [
  'authentication authorization access token validation',
  'workspace daemon request error handling',
  'model routing fallback completion',
  'security finding evidence report',
  'parallel task worktree checkpoint',
];

export async function runCodingCoreBenchmark(
  index: SemanticWorkspaceIndex,
  completionLatencies: number[] = [],
): Promise<CodingCoreBenchmark> {
  const semanticIndex = await index.build();
  const latencies: number[] = [];
  let resultsReturned = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    for (const query of BENCHMARK_QUERIES) {
      const startedAt = performance.now();
      resultsReturned += index.search(query, 12).length;
      latencies.push(performance.now() - startedAt);
    }
  }
  const memory = process.memoryUsage();
  return {
    measuredAt: new Date().toISOString(),
    semanticIndex,
    search: {
      samples: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maxMs: round(Math.max(0, ...latencies)),
      resultsReturned,
    },
    completion: {
      samples: completionLatencies.length,
      ...(completionLatencies.length
        ? {
            p50Ms: percentile(completionLatencies, 0.5),
            p95Ms: percentile(completionLatencies, 0.95),
          }
        : {}),
    },
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    gates: {
      indexUnderFiveSeconds: semanticIndex.durationMs < 5_000,
      searchP95UnderFiftyMs: percentile(latencies, 0.95) < 50,
      rssUnderOneGigabyte: memory.rss < 1024 * 1024 * 1024,
    },
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
