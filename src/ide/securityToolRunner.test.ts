import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import type { OrchestrationSnapshot, OrchestrationSpec } from './orchestrator.js';
import { GovernedSecurityToolRunner } from './securityToolRunner.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('governed security tool runner', () => {
  it('plans, executes and imports SARIF from an approved adapter lane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-adapter-'));
    roots.push(root);
    const orchestrator = new FakeAdapterOrchestrator(root);
    const runner = new GovernedSecurityToolRunner({
      workspaceRoot: root,
      store: new DurableStore(root),
      orchestrator,
    });
    const plan = await runner.createPlan({
      adapter: 'semgrep',
      image: 'semgrep/semgrep:latest',
      target: '.',
      args: ['scan', '--sarif', '--config=auto', '${target}'],
    });
    expect(plan.executable).toBe('semgrep');
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    const result = await runner.execute(plan, true);
    expect(result).toMatchObject({
      status: 'completed',
      adapter: 'semgrep',
      findings: [expect.objectContaining({ ruleId: 'semgrep:test.rule' })],
    });
    expect(orchestrator.spec?.networkMode).toBe('none');
  });

  it('requires explicit approval before restricted network execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-adapter-'));
    roots.push(root);
    const runner = new GovernedSecurityToolRunner({
      workspaceRoot: root,
      store: new DurableStore(root),
      orchestrator: new FakeAdapterOrchestrator(root),
    });
    await expect(
      runner.createPlan({
        adapter: 'zap',
        image: 'owasp/zap2docker-stable',
        target: '.',
        args: ['-t', '${target}'],
        networkMode: 'restricted',
        allowedHosts: ['example.com'],
      }),
    ).rejects.toThrow('explicit external-access approval');
  });
});

class FakeAdapterOrchestrator {
  spec?: OrchestrationSpec;
  private snapshot?: OrchestrationSnapshot;
  constructor(private readonly root: string) {}
  async start(spec: OrchestrationSpec): Promise<OrchestrationSnapshot> {
    this.spec = spec;
    this.snapshot = {
      protocolVersion: 3,
      id: 'adapter-run-test',
      status: 'succeeded',
      image: spec.image,
      workspaceRoot: this.root,
      outputRoot: join(this.root, '.hawk', 'output'),
      maxParallel: 1,
      cpuPerWorker: 1,
      memoryMbPerWorker: 1024,
      artifactMbPerWorker: 64,
      networkMode: 'none',
      inheritedEnv: [],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cancelRequested: false,
      scheduler: { strategy: 'balanced', leaseSeconds: 60, instances: [], decisions: [] },
      summary: {
        total: 1,
        pending: 0,
        running: 0,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      tasks: [
        {
          id: 'adapter-scan',
          title: 'Run semgrep adapter',
          status: 'succeeded',
          dependsOn: [],
          attempt: 1,
          artifactDirectory: join(this.root, '.hawk', 'output'),
          reassignments: 0,
          output: JSON.stringify({
            version: '2.1.0',
            runs: [
              {
                tool: { driver: { name: 'semgrep' } },
                results: [
                  { ruleId: 'test.rule', level: 'warning', message: { text: 'test finding' } },
                ],
              },
            ],
          }),
        },
      ],
    };
    return this.snapshot;
  }
  get(): OrchestrationSnapshot | undefined {
    return this.snapshot;
  }
  async shutdown(): Promise<void> {}
}
