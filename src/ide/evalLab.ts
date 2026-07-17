import { randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';

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

export class HawkEvalLab {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    return record;
  }

  async list(): Promise<HawkEvalRecord[]> {
    return (await this.store.listJson<HawkEvalRecord>('eval-runs')).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
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
