import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceScanPlan,
  createWorkspaceScanTemplates,
  runApprovedWorkspaceScan,
} from './workspaceScan.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace scan workflow', () => {
  it('requires approval and writes a passive local report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-workspace-scan-'));
    roots.push(root);
    await writeFile(join(root, 'server.ts'), "app.get('/status', handler);\neval(input);\n");
    const now = new Date('2026-07-17T12:00:00.000Z');
    const plan = createWorkspaceScanPlan(root, 'passive-workspace', now);
    expect(plan).toMatchObject({
      templateId: 'passive-workspace',
      scope: 'passive-workspace',
      requiresApproval: true,
      approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      runApprovedWorkspaceScan({
        workspaceRoot: root,
        templateId: plan.templateId,
        approvalHash: plan.approvalHash,
        approved: false,
        now,
      }),
    ).rejects.toThrow('approval');

    const report = await runApprovedWorkspaceScan({
      workspaceRoot: root,
      templateId: plan.templateId,
      approvalHash: plan.approvalHash,
      approved: true,
      now,
    });
    expect(report).toMatchObject({
      routes: 1,
      findings: [expect.objectContaining({ ruleId: 'dynamic-code-execution' })],
    });
    await expect(readFile(join(root, ...report.reportPath.split('/')), 'utf8')).resolves.toContain(
      'Passive workspace review',
    );
  });

  it('publishes bounded templates and rejects approval from another plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-workspace-template-'));
    roots.push(root);
    const templates = createWorkspaceScanTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      'passive-workspace',
      'runtime-observe',
      'release-gate',
    ]);
    expect(templates.every((template) => template.requiresApproval)).toBe(true);
    const plan = createWorkspaceScanPlan(root, 'runtime-observe');
    await expect(
      runApprovedWorkspaceScan({
        workspaceRoot: root,
        templateId: plan.templateId,
        approvalHash: '0'.repeat(64),
        approved: true,
      }),
    ).rejects.toThrow('different plan');
  });
});
