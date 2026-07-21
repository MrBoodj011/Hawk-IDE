import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSecurityTestPlan,
  listSecurityTestTemplates,
  runApprovedSecurityTest,
} from './securityTesting.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('governed security tests', () => {
  it('publishes approval-bound templates and executes a passive test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-security-test-'));
    roots.push(root);
    await writeFile(join(root, 'server.ts'), "app.get('/health', handler);\neval(input);\n");
    const templates = await listSecurityTestTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      'static-code',
      'route-coverage',
      'dependency-manifest',
      'sandbox-signal',
    ]);
    const plan = await createSecurityTestPlan({ workspaceRoot: root, templateId: 'static-code' });
    expect(plan).toMatchObject({
      execution: 'offline',
      governance: { decision: 'require-approval' },
      approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      runApprovedSecurityTest({
        workspaceRoot: root,
        plan,
        approvalHash: plan.approvalHash,
        approved: false,
      }),
    ).rejects.toThrow('approval');
    const result = await runApprovedSecurityTest({
      workspaceRoot: root,
      plan,
      approvalHash: plan.approvalHash,
      approved: true,
    });
    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: 'dynamic-code-execution' }),
    ]);
    await expect(readFile(join(root, ...result.reportPath.split('/')), 'utf8')).resolves.toContain(
      'static-code',
    );
  });

  it('refuses a plan when the workspace governance policy changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-security-test-policy-'));
    roots.push(root);
    const plan = await createSecurityTestPlan({
      workspaceRoot: root,
      templateId: 'route-coverage',
    });
    await writeFile(
      join(root, '.hawk-governance-marker'),
      'This marker proves the plan remains local and does not authorize network work.',
    );
    await expect(
      runApprovedSecurityTest({
        workspaceRoot: root,
        plan: { ...plan, policyHash: '0'.repeat(64) },
        approvalHash: plan.approvalHash,
        approved: true,
      }),
    ).rejects.toThrow('governance policy changed');
  });

  it('inspects dependency manifests without installing or executing scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-security-test-deps-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { install: 'node setup.js', test: 'vitest' } }),
    );
    await writeFile(join(root, 'package-lock.json'), '{}');
    const plan = await createSecurityTestPlan({
      workspaceRoot: root,
      templateId: 'dependency-manifest',
    });
    const result = await runApprovedSecurityTest({
      workspaceRoot: root,
      plan,
      approvalHash: plan.approvalHash,
      approved: true,
    });
    expect(result.findings).toEqual([]);
    expect(result.dependency).toMatchObject({
      manifests: ['package.json'],
      lockfiles: ['package-lock.json'],
      installScripts: ['package.json:install'],
      packageManagers: ['npm'],
    });
  });
});
