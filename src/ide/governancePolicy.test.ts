import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateGovernance,
  governancePolicyHash,
  loadGovernancePolicy,
  writeGovernancePolicy,
} from './governancePolicy.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('governance policy', () => {
  it('loads a safe default and requires approval for security tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-governance-'));
    roots.push(root);
    const policy = await loadGovernancePolicy(root);
    expect(policy.defaultDecision).toBe('require-approval');
    expect(governancePolicyHash(policy)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      evaluateGovernance(policy, {
        templateId: 'static-code',
        hosts: [],
        requestsPerSecond: 0,
        networkPolicy: 'offline',
        approved: false,
      }).decision,
    ).toBe('require-approval');
  });

  it('persists and enforces bounded policy limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-governance-file-'));
    roots.push(root);
    await writeGovernancePolicy(root, {
      schemaVersion: 1,
      defaultDecision: 'require-approval',
      requireApprovalFor: ['static-code'],
      allowedTemplates: ['static-code'],
      maxHosts: 1,
      maxRequestsPerSecond: 2,
      maxParallel: 2,
      allowedNetworkPolicies: ['offline'],
      requireEvidenceForPromotion: true,
    });
    const policy = await loadGovernancePolicy(root);
    const evaluation = evaluateGovernance(policy, {
      templateId: 'route-coverage',
      hosts: ['one.test', 'two.test'],
      requestsPerSecond: 5,
      networkPolicy: 'captured-only',
      approved: true,
    });
    expect(evaluation.decision).toBe('deny');
    expect(evaluation.reasons.length).toBeGreaterThan(1);
    await expect(
      writeFile(join(root, '.hawk', 'governance.json'), '{"schemaVersion": 2}'),
    ).resolves.toBeUndefined();
  });
});
