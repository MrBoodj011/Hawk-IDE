import { describe, expect, it } from 'vitest';
import { HawkModelRouter } from './modelRouter.js';
import type { CapabilityDescriptor, GoalSpec } from './smartTypes.js';

const capability: CapabilityDescriptor = {
  id: 'code.secure.review',
  title: 'Secure code review',
  description: 'Review code',
  category: 'code',
  risk: 'high',
  requiredActions: ['read-workspace'],
  deterministic: false,
  averageDurationSeconds: 30,
  estimatedCostUsd: 0,
  reliability: 0.9,
  evidenceKinds: ['finding'],
  provenance: 'hawk-core',
  version: '1',
  enabled: true,
};

const goal: GoalSpec = {
  protocolVersion: 1,
  id: 'goal-1',
  objective: 'Review authentication code',
  workspaceRoot: '/workspace',
  scope: { repositories: [], hosts: [], routes: [], identities: [] },
  allowedActions: ['read-workspace'],
  forbiddenActions: [],
  budgets: {
    maxParallel: 1,
    maxMinutes: 10,
    maxTokens: 10_000,
    maxCostUsd: 1,
    requestsPerSecond: 0,
  },
  modelPolicy: { dataPolicy: 'local-only', preferredModels: {} },
  approvalMode: 'on-risk',
  successCriteria: ['report'],
  retentionDays: 1,
  createdAt: '2026-07-21T10:00:00Z',
};

describe('adaptive model router', () => {
  it('ranks measured local models and exposes a shadow candidate and cache contract', () => {
    const router = new HawkModelRouter([
      {
        providerModel: 'ollama/code-fast',
        modelClass: 'local-small',
        roles: ['code-review'],
        quality: 0.78,
        reliability: 0.99,
        p95LatencyMs: 600,
        costPerMillionTokensUsd: 0,
        contextWindow: 32_000,
        local: true,
        sampleSize: 100,
      },
      {
        providerModel: 'ollama/code-deep',
        modelClass: 'local-small',
        roles: ['code-review'],
        quality: 0.92,
        reliability: 0.96,
        p95LatencyMs: 4_000,
        costPerMillionTokensUsd: 0,
        contextWindow: 64_000,
        local: true,
        sampleSize: 80,
      },
      {
        providerModel: 'hosted/private',
        modelClass: 'local-small',
        roles: ['code-review'],
        quality: 1,
        reliability: 1,
        p95LatencyMs: 100,
        costPerMillionTokensUsd: 0,
        contextWindow: 100_000,
        local: false,
        sampleSize: 100,
      },
    ]);
    const decision = router.route(capability, goal);
    expect(decision.modelRoute.providerModel).toBe('ollama/code-deep');
    expect(decision.scorecard).toMatchObject({
      cacheKey: expect.stringMatching(/^model-route-/),
      cacheTtlSeconds: 300,
      shadowCandidate: 'ollama/code-fast',
    });
    expect(
      decision.scorecard?.candidates.map((candidate) => candidate.providerModel),
    ).not.toContain('hosted/private');
  });

  it('switches the live route when a new evaluation snapshot arrives', () => {
    const remediation = { ...capability, category: 'remediation' as const };
    const router = new HawkModelRouter([
      {
        providerModel: 'ollama/old-coder',
        modelClass: 'local-code',
        quality: 0.7,
        reliability: 0.7,
        p95LatencyMs: 2_000,
        costPerMillionTokensUsd: 0,
        contextWindow: 16_384,
        local: true,
        sampleSize: 2,
      },
    ]);
    expect(router.route(remediation, goal).modelRoute.providerModel).toBe('ollama/old-coder');

    router.setProfiles([
      {
        providerModel: 'ollama/live-coder',
        modelClass: 'local-code',
        quality: 0.98,
        reliability: 0.99,
        p95LatencyMs: 300,
        costPerMillionTokensUsd: 0,
        contextWindow: 32_000,
        local: true,
        sampleSize: 40,
      },
    ]);
    const decision = router.route(remediation, goal);
    expect(decision.modelRoute.providerModel).toBe('ollama/live-coder');
    expect(decision.scorecard?.candidates[0]?.providerModel).toBe('ollama/live-coder');
  });
});
