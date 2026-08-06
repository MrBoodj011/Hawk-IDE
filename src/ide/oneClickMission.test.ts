import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import { type OneClickMissionOperations, OneClickMissionService } from './oneClickMission.js';
import type { GovernedMissionPlan, OneClickMissionRun } from './protocol.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('one-click proof mission', () => {
  it('persists every passive stage and stops all active work behind proof gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-proof-mission-'));
    roots.push(root);
    const service = new OneClickMissionService(root, new DurableStore(root));
    const run = await service.start(plan(), operations(2));

    expect(run.status).toBe('awaiting-approval');
    expect(run.stages.filter((stage) => stage.execution === 'automatic')).toSatisfy((stages) =>
      stages.every((stage) => stage.status === 'completed'),
    );
    expect(run.stages.filter((stage) => stage.execution === 'approval-gate')).toSatisfy((stages) =>
      stages.every((stage) => stage.status === 'awaiting-approval'),
    );
    expect(run.proof).toMatchObject({ verdict: 'unverified', passed: 3, total: 12 });
    expect(run.summary).toMatchObject({ findings: 2, evidenceArtifacts: 5, graphNodes: 8 });
    const report = await readFile(join(root, ...run.reportPath.split('/')), 'utf8');
    expect(report).toContain('Hawk One-click Proof Mission');
    expect(report).toContain('Blocked until an exact finding-bound plan is approved');
  });

  it('completes cleanly when passive discovery has no signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-proof-clean-'));
    roots.push(root);
    const service = new OneClickMissionService(root, new DurableStore(root));
    const run = await service.start(plan(), operations(0));
    expect(run).toMatchObject({ status: 'completed', proof: { verdict: 'no-signals' } });
    expect(run.stages.filter((stage) => stage.execution === 'approval-gate')).toSatisfy((stages) =>
      stages.every((stage) => stage.status === 'skipped'),
    );
  });

  it('marks interrupted work as restart-recoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-proof-recovery-'));
    roots.push(root);
    const store = new DurableStore(root);
    const service = new OneClickMissionService(root, store);
    const completed = await service.start(plan(), operations(0));
    const interrupted: OneClickMissionRun = {
      ...completed,
      id: 'proof-mission-interrupted',
      status: 'running',
      completedAt: undefined,
      stages: completed.stages.map((stage, index) =>
        index === 1 ? { ...stage, status: 'running' } : stage,
      ),
    };
    await store.writeJson('one-click-missions', interrupted.id, interrupted);
    await expect(service.recoverInterrupted()).resolves.toBe(1);
    await expect(service.get(interrupted.id)).resolves.toMatchObject({
      status: 'paused',
      recoveredAfterRestart: true,
    });
  });
});

function plan(): GovernedMissionPlan {
  return {
    protocolVersion: 14,
    id: 'plan-proof',
    goalId: 'goal-proof',
    profile: 'review',
    objective: 'Prove the workspace security posture',
    planHash: 'a'.repeat(64),
    decision: 'allow',
    reasons: [],
    allowedActions: ['read-workspace'],
    hosts: [],
    maxParallel: 4,
    estimatedMinutes: 1,
    estimatedCostUsd: 0,
    approvalRequired: false,
    nodes: [],
    reportPath: '.hawk/plans/plan-proof.md',
    createdAt: '2026-08-06T10:00:00.000Z',
  };
}

function operations(findings: number): OneClickMissionOperations {
  return {
    inventory: async () => ({ sourceFiles: 12 }),
    protocols: async () => ({ summary: { total: 3 } }),
    audit: async () => ({ findings: Array.from({ length: findings }, (_, id) => ({ id })) }),
    attackTwin: async () => ({ paths: [{ id: 'path-1' }] }),
    proofCorrelation: async () => ({ nodes: 8, edges: 9, correlated: true }),
    evidencePack: async () => ({
      directoryPath: '.hawk/reports/evidence-test',
      artifacts: Array.from({ length: 5 }, (_, id) => ({ id })),
    }),
  };
}
