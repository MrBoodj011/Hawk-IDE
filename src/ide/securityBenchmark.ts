export type BenchmarkTruth = 'true-positive' | 'false-positive' | 'unknown';

export interface SecurityBenchmarkSample {
  repo: string;
  findingId: string;
  detected: boolean;
  reproduced: boolean;
  truth?: BenchmarkTruth;
  fixed?: boolean;
  testsPassed?: boolean;
  durationMs: number;
  memoryBytes?: number;
  costUsd?: number;
}

export interface SecurityBenchmarkReport {
  dataset: string;
  generatedAt: string;
  repos: number;
  samples: number;
  findings: number;
  reproductionRate: number;
  falsePositiveRate?: number;
  fixSuccessRate?: number;
  testsPassRate?: number;
  timing: { p50Ms: number; p95Ms: number; maxMs: number };
  memory: { averageBytes?: number; peakBytes?: number };
  cost: { totalUsd: number; averageUsd: number };
  gates: {
    reproductionMeasured: boolean;
    falsePositivesMeasured: boolean;
    fixesMeasured: boolean;
    resourceMeasured: boolean;
  };
  samplesDetail: SecurityBenchmarkSample[];
}

export function summarizeSecurityBenchmark(
  input: SecurityBenchmarkSample[],
  dataset = 'hawk-public-benchmark',
  now = new Date(),
): SecurityBenchmarkReport {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('Benchmark requires at least one sample');
  if (input.length > 5_000) throw new Error('Benchmark is limited to 5,000 samples');
  const samples = input.map(normalizeSample);
  const detected = samples.filter((sample) => sample.detected);
  const reproduced = detected.filter((sample) => sample.reproduced);
  const labeled = samples.filter(
    (sample) => sample.truth === 'true-positive' || sample.truth === 'false-positive',
  );
  const falsePositives = labeled.filter((sample) => sample.truth === 'false-positive');
  const fixed = reproduced.filter((sample) => sample.fixed === true);
  const tested = reproduced.filter((sample) => sample.testsPassed !== undefined);
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const memory = samples
    .map((sample) => sample.memoryBytes)
    .filter((value): value is number => value !== undefined);
  const costs = samples.map((sample) => sample.costUsd ?? 0);
  const repos = new Set(samples.map((sample) => sample.repo)).size;
  return {
    dataset: normalizeText(dataset, 'hawk-public-benchmark', 200),
    generatedAt: now.toISOString(),
    repos,
    samples: samples.length,
    findings: detected.length,
    reproductionRate: ratio(reproduced.length, detected.length),
    ...(labeled.length ? { falsePositiveRate: ratio(falsePositives.length, labeled.length) } : {}),
    ...(reproduced.length ? { fixSuccessRate: ratio(fixed.length, reproduced.length) } : {}),
    ...(tested.length
      ? {
          testsPassRate: ratio(tested.filter((sample) => sample.testsPassed).length, tested.length),
        }
      : {}),
    timing: {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1) ?? 0,
    },
    memory: memory.length
      ? {
          averageBytes: Math.round(memory.reduce((sum, value) => sum + value, 0) / memory.length),
          peakBytes: Math.max(...memory),
        }
      : {},
    cost: {
      totalUsd: round(costs.reduce((sum, value) => sum + value, 0)),
      averageUsd: round(costs.reduce((sum, value) => sum + value, 0) / samples.length),
    },
    gates: {
      reproductionMeasured: detected.length > 0,
      falsePositivesMeasured: labeled.length > 0,
      fixesMeasured: reproduced.length > 0,
      resourceMeasured: memory.length > 0 || costs.some((value) => value > 0),
    },
    samplesDetail: samples,
  };
}

function normalizeSample(value: SecurityBenchmarkSample): SecurityBenchmarkSample {
  if (!value || typeof value !== 'object') throw new Error('Benchmark sample must be an object');
  const sample = value as SecurityBenchmarkSample;
  if (!normalizeText(sample.repo, '', 300) || !normalizeText(sample.findingId, '', 300))
    throw new Error('Benchmark repo and findingId are required');
  if (
    !Number.isFinite(sample.durationMs) ||
    sample.durationMs < 0 ||
    sample.durationMs > 86_400_000
  )
    throw new Error('Benchmark durationMs is invalid');
  const optionalNumbers: Array<[string, number | undefined]> = [
    ['memoryBytes', sample.memoryBytes],
    ['costUsd', sample.costUsd],
  ];
  for (const [key, numberValue] of optionalNumbers) {
    if (numberValue !== undefined && (!Number.isFinite(numberValue) || numberValue < 0))
      throw new Error(`Benchmark ${key} is invalid`);
  }
  return {
    repo: normalizeText(sample.repo, '', 300),
    findingId: normalizeText(sample.findingId, '', 300),
    detected: Boolean(sample.detected),
    reproduced: Boolean(sample.reproduced),
    ...(sample.truth ? { truth: sample.truth } : {}),
    ...(sample.fixed !== undefined ? { fixed: Boolean(sample.fixed) } : {}),
    ...(sample.testsPassed !== undefined ? { testsPassed: Boolean(sample.testsPassed) } : {}),
    durationMs: Math.round(sample.durationMs),
    ...(sample.memoryBytes !== undefined ? { memoryBytes: Math.round(sample.memoryBytes) } : {}),
    ...(sample.costUsd !== undefined ? { costUsd: round(sample.costUsd) } : {}),
  };
}

function normalizeText(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}
function ratio(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}
function round(value: number): number {
  return Number(value.toFixed(6));
}
