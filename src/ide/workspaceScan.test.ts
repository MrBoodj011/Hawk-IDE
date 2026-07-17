import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceScanPlan, runApprovedWorkspaceScan } from './workspaceScan.js';

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
    const plan = createWorkspaceScanPlan(root, now);
    expect(plan).toMatchObject({ scope: 'passive-workspace', requiresApproval: true });
    await expect(
      runApprovedWorkspaceScan({ workspaceRoot: root, scope: plan.scope, approved: false, now }),
    ).rejects.toThrow('approval');

    const report = await runApprovedWorkspaceScan({
      workspaceRoot: root,
      scope: plan.scope,
      approved: true,
      now,
    });
    expect(report).toMatchObject({
      routes: 1,
      findings: [expect.objectContaining({ ruleId: 'dynamic-code-execution' })],
    });
    await expect(readFile(join(root, ...report.reportPath.split('/')), 'utf8')).resolves.toContain(
      'Passive workspace-only analysis',
    );
  });
});
