import { randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import type { ModelPerformanceProfile } from './modelRouter.js';

export interface HawkEvalRecord {
  protocolVersion: 1;
  id: string;
  scenario: string;
  system: 'hawk' | 'baseline';
  model: string;
  tokenBudget: number;
  costBudgetUsd: number;
  success: boolean;
  signals: number;
  verifiedFindings: number;
  falsePositives: number;
  overScopeActions: number;
  regressions: number;
  elapsedSeconds: number;
  actualCostUsd: number;
  createdAt: string;
}

export interface HawkEvalSummary {
  protocolVersion: 1;
  comparableRuns: number;
  excludedNonComparableRuns: number;
  hawk: EvalAggregate;
  baseline: EvalAggregate;
  deltas: {
    successRate: number;
    falsePositiveRate: number;
    costPerVerifiedFindingUsd: number | null;
    secondsPerVerifiedFinding: number | null;
    overScopeActions: number;
  };
}

interface EvalAggregate {
  runs: number;
  successRate: number;
  falsePositiveRate: number;
  verifiedFindings: number;
  overScopeActions: number;
  regressions: number;
  costPerVerifiedFindingUsd: number | null;
  secondsPerVerifiedFinding: number | null;
}

const DEFAULT_PROFILE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function profileFor(providerModel: string, records: HawkEvalRecord[]): ModelPerformanceProfile {
  const runs = records.length;
  const successes = records.filter((record) => record.success).length;
  const verified = records.reduce((sum, record) => sum + record.verifiedFindings, 0);
  const falsePositives = records.reduce((sum, record) => sum + record.falsePositives, 0);
  const regressions = records.reduce((sum, record) => sum + record.regressions, 0);
  const overScope = records.reduce((sum, record) => sum + record.overScopeActions, 0);
  const precision = verified + falsePositives > 0 ? verified / (verified + falsePositives) : 0;
  const successRate = runs > 0 ? successes / runs : 0;
  const regressionSafety = Math.max(0, 1 - regressions / Math.max(1, runs));
  const scopeSafety = Math.max(0, 1 - overScope / Math.max(1, runs));
  // Quality rewards useful, verified output while retaining a strong penalty
  // for failed runs and unsafe side effects.
  const quality =
    successRate * 0.45 + precision * 0.35 + regressionSafety * 0.1 + scopeSafety * 0.1;
  const reliability = successRate * regressionSafety * scopeSafety;
  const latencies = records.map((record) => record.elapsedSeconds * 1000).sort((a, b) => a - b);
  const p95Index = Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1);
  const p95LatencyMs = latencies.length > 0 ? (latencies[Math.max(0, p95Index)] ?? 0) : 0;
  const tokenBudget = records.reduce((sum, record) => sum + record.tokenBudget, 0);
  const actualCost = records.reduce((sum, record) => sum + record.actualCostUsd, 0);
  const local = isLocalModel(providerModel);
  const lastEvaluatedAt = records
    .map((record) => record.createdAt)
    .sort((left, right) => right.localeCompare(left))[0];
  return {
    providerModel,
    modelClass: inferModelClass(providerModel, local),
    quality: round(Math.max(0, Math.min(1, quality))),
    reliability: round(Math.max(0, Math.min(1, reliability))),
    p95LatencyMs: round(p95LatencyMs),
    costPerMillionTokensUsd: round(tokenBudget > 0 ? (actualCost / tokenBudget) * 1_000_000 : 0),
    // Eval records intentionally do not persist prompts or context metadata.
    // Keep a conservative default for the router's future context checks.
    contextWindow: 16_384,
    local,
    sampleSize: runs,
    ...(lastEvaluatedAt ? { lastEvaluatedAt } : {}),
  };
}

function isLocalModel(providerModel: string): boolean {
  return /^(?:ollama|lmstudio|local|deterministic|rules|static|ast)(?:[/:_-]|$)/i.test(
    providerModel,
  );
}

function inferModelClass(
  providerModel: string,
  local: boolean,
): ModelPerformanceProfile['modelClass'] {
  const normalized = providerModel.toLowerCase();
  if (/(?:^|[-_/:])(?:deterministic|static|ast|rules)(?:$|[-_/:])/.test(normalized))
    return 'deterministic';
  const code = /code|coder|devstral|starcoder|qwen2?\.5-coder|deepseek-coder/.test(normalized);
  if (local) return code ? 'local-code' : 'local-small';
  return code ? 'hosted-code' : 'hosted-reasoning';
}

export class HawkEvalLab {
  private readonly profileListeners = new Set<(profiles: ModelPerformanceProfile[]) => void>();

  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Subscribe to the measured model snapshot. The listener is synchronous so
   * route updates are atomic from the caller's perspective; unsubscribe when
   * the owning brain is disposed.
   */
  onModelProfilesChanged(listener: (profiles: ModelPerformanceProfile[]) => void): () => void {
    this.profileListeners.add(listener);
    return () => this.profileListeners.delete(listener);
  }

  async record(input: Omit<HawkEvalRecord, 'protocolVersion' | 'id' | 'createdAt'>) {
    validate(input);
    const record: HawkEvalRecord = {
      protocolVersion: 1,
      id: `eval-${randomUUID()}`,
      ...input,
      scenario: input.scenario.trim().slice(0, 500),
      model: input.model.trim().slice(0, 160),
      createdAt: this.now().toISOString(),
    };
    await this.store.writeJson('eval-runs', record.id, record);
    const profiles = await this.performanceProfiles();
    for (const listener of this.profileListeners) listener(profiles);
    return record;
  }

  async list(): Promise<HawkEvalRecord[]> {
    return (await this.store.listJson<HawkEvalRecord>('eval-runs')).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /**
   * Convert completed Hawk evaluation runs into the profile shape consumed by
   * the live model router. Baseline runs remain comparison-only and never
   * influence production routing. A profile is rebuilt from durable records on
   * every call, so restarts do not lose measured behaviour.
   */
  async performanceProfiles(
    maxAgeSeconds = DEFAULT_PROFILE_MAX_AGE_SECONDS,
  ): Promise<ModelPerformanceProfile[]> {
    const cutoff = this.now().getTime() - Math.max(0, maxAgeSeconds) * 1000;
    const records = (await this.list()).filter((record) => {
      if (record.system !== 'hawk') return false;
      const createdAt = Date.parse(record.createdAt);
      // Unknown timestamps are not trusted for live routing. They remain
      // available to summary/list, but cannot silently become stale profiles.
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    });
    const byModel = new Map<string, HawkEvalRecord[]>();
    for (const record of records) {
      const model = record.model.trim();
      const bucket = byModel.get(model) ?? [];
      bucket.push(record);
      byModel.set(model, bucket);
    }
    return [...byModel.entries()]
      .map(([providerModel, modelRuns]) => profileFor(providerModel, modelRuns))
      .sort((left, right) => left.providerModel.localeCompare(right.providerModel));
  }

  async summary(): Promise<HawkEvalSummary> {
    const all = await this.list();
    const comparableKeys = new Set<string>();
    const byKey = new Map<string, Set<HawkEvalRecord['system']>>();
    for (const record of all) {
      const key = comparisonKey(record);
      const systems = byKey.get(key) ?? new Set();
      systems.add(record.system);
      byKey.set(key, systems);
    }
    for (const [key, systems] of byKey) {
      if (systems.has('hawk') && systems.has('baseline')) comparableKeys.add(key);
    }
    const comparable = all.filter((record) => comparableKeys.has(comparisonKey(record)));
    const hawk = aggregate(comparable.filter((record) => record.system === 'hawk'));
    const baseline = aggregate(comparable.filter((record) => record.system === 'baseline'));
    return {
      protocolVersion: 1,
      comparableRuns: comparable.length,
      excludedNonComparableRuns: all.length - comparable.length,
      hawk,
      baseline,
      deltas: {
        successRate: round(hawk.successRate - baseline.successRate),
        falsePositiveRate: round(hawk.falsePositiveRate - baseline.falsePositiveRate),
        costPerVerifiedFindingUsd: nullableDelta(
          hawk.costPerVerifiedFindingUsd,
          baseline.costPerVerifiedFindingUsd,
        ),
        secondsPerVerifiedFinding: nullableDelta(
          hawk.secondsPerVerifiedFinding,
          baseline.secondsPerVerifiedFinding,
        ),
        overScopeActions: hawk.overScopeActions - baseline.overScopeActions,
      },
    };
  }
}

function aggregate(records: HawkEvalRecord[]): EvalAggregate {
  const verified = records.reduce((sum, record) => sum + record.verifiedFindings, 0);
  const signals = records.reduce((sum, record) => sum + record.signals, 0);
  const falsePositives = records.reduce((sum, record) => sum + record.falsePositives, 0);
  const cost = records.reduce((sum, record) => sum + record.actualCostUsd, 0);
  const seconds = records.reduce((sum, record) => sum + record.elapsedSeconds, 0);
  return {
    runs: records.length,
    successRate:
      records.length > 0
        ? round(records.filter((record) => record.success).length / records.length)
        : 0,
    falsePositiveRate: signals > 0 ? round(falsePositives / signals) : 0,
    verifiedFindings: verified,
    overScopeActions: records.reduce((sum, record) => sum + record.overScopeActions, 0),
    regressions: records.reduce((sum, record) => sum + record.regressions, 0),
    costPerVerifiedFindingUsd: verified > 0 ? round(cost / verified) : null,
    secondsPerVerifiedFinding: verified > 0 ? round(seconds / verified) : null,
  };
}

function validate(input: Omit<HawkEvalRecord, 'protocolVersion' | 'id' | 'createdAt'>): void {
  if (!input.scenario.trim()) throw new Error('Eval scenario is required');
  if (!input.model.trim()) throw new Error('Eval model is required');
  const integers = [
    input.tokenBudget,
    input.signals,
    input.verifiedFindings,
    input.falsePositives,
    input.overScopeActions,
    input.regressions,
  ];
  if (integers.some((value) => !Number.isInteger(value) || value < 0))
    throw new Error('Eval counts and token budget must be non-negative integers');
  if (
    [input.costBudgetUsd, input.elapsedSeconds, input.actualCostUsd].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error('Eval cost and elapsed values must be non-negative');
  if (input.falsePositives > input.signals)
    throw new Error('False positives cannot exceed detected signals');
  if (input.actualCostUsd > input.costBudgetUsd)
    throw new Error('Actual cost exceeds the declared comparable-run budget');
}

function comparisonKey(record: HawkEvalRecord): string {
  return JSON.stringify([
    record.scenario.toLowerCase(),
    record.model.toLowerCase(),
    record.tokenBudget,
    record.costBudgetUsd,
  ]);
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : round(left - right);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
