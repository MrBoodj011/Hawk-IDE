import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import { HawkEvalLab } from './evalLab.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('live model evaluation profiles', () => {
  it('aggregates Hawk runs and publishes updates without using baselines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-eval-lab-'));
    directories.push(root);
    const lab = new HawkEvalLab(new DurableStore(root));
    const updates: string[][] = [];
    lab.onModelProfilesChanged((profiles) =>
      updates.push(profiles.map((profile) => profile.providerModel)),
    );
    const common = {
      scenario: 'route audit',
      model: 'ollama/code-fast',
      tokenBudget: 10_000,
      costBudgetUsd: 1,
      signals: 4,
      overScopeActions: 0,
      regressions: 0,
      elapsedSeconds: 2,
      actualCostUsd: 0,
    };
    await lab.record({
      ...common,
      system: 'hawk',
      success: true,
      verifiedFindings: 3,
      falsePositives: 1,
    });
    await lab.record({
      ...common,
      system: 'baseline',
      success: false,
      verifiedFindings: 0,
      falsePositives: 4,
    });

    const profiles = await lab.performanceProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      providerModel: 'ollama/code-fast',
      modelClass: 'local-code',
      local: true,
      sampleSize: 1,
      p95LatencyMs: 2_000,
    });
    expect(updates).toEqual([['ollama/code-fast'], ['ollama/code-fast']]);
  });

  it('drops profiles older than the live-routing freshness window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-eval-freshness-'));
    directories.push(root);
    let now = new Date('2026-07-22T12:00:00.000Z');
    const lab = new HawkEvalLab(new DurableStore(root), () => now);
    await lab.record({
      scenario: 'old route',
      system: 'hawk',
      model: 'ollama/code-old',
      tokenBudget: 1,
      costBudgetUsd: 0,
      success: true,
      signals: 0,
      verifiedFindings: 0,
      falsePositives: 0,
      overScopeActions: 0,
      regressions: 0,
      elapsedSeconds: 1,
      actualCostUsd: 0,
    });
    expect(await lab.performanceProfiles(0)).toHaveLength(1);
    now = new Date(now.getTime() + 1_000);
    expect(await lab.performanceProfiles(0)).toHaveLength(0);
  });
});
