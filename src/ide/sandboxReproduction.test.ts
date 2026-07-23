import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import type {
  OrchestrationSnapshot,
  OrchestrationSpec,
  OrchestrationTaskSnapshot,
} from './orchestrator.js';
import type { SecurityFinding } from './protocol.js';
import { SandboxVulnerabilityReproducer } from './sandboxReproduction.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SandboxVulnerabilityReproducer', () => {
  it('runs a hash-bound baseline, control, and reproduction DAG with zero network', async () => {
    const root = await temporaryRoot();
    const orchestrator = new SuccessfulReproductionOrchestrator(root);
    const reproducer = new SandboxVulnerabilityReproducer(
      root,
      new DurableStore(root),
      orchestrator,
      () => new Date('2026-07-20T15:00:00.000Z'),
    );
    const finding = fixtureFinding();

    const plan = await reproducer.createPlan(finding, 'hawk-worker:test');
    const result = await reproducer.execute(finding, {
      planId: plan.id,
      planHash: plan.planHash,
      approved: true,
    });

    expect(plan).toMatchObject({
      mode: 'offline-signal',
      isolation: {
        workspace: 'read-only',
        rootFilesystem: 'read-only',
        network: 'none',
        capabilities: 'dropped',
      },
      gates: [{ id: 'baseline' }, { id: 'control' }, { id: 'reproduction' }],
      source: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(orchestrator.spec).toMatchObject({
      networkMode: 'none',
      maxParallel: 1,
      cpuPerWorker: 0.5,
      memoryMbPerWorker: 256,
      tasks: [
        { id: 'baseline', requiredCapabilities: ['reproduction'] },
        { id: 'control', dependsOn: ['baseline'] },
        { id: 'reproduction', dependsOn: ['control'] },
      ],
    });
    expect(JSON.stringify(orchestrator.spec)).not.toContain('sensitive-value');
    expect(result).toMatchObject({
      status: 'reproduced',
      lifecycle: 'reproduced',
      promotedToVerified: false,
      gates: [
        { id: 'baseline', status: 'passed' },
        { id: 'control', status: 'passed' },
        { id: 'reproduction', status: 'passed' },
      ],
    });
    expect(result.missingVerificationGates).toContain('independent reproduction');
    await expect(reproducer.list()).resolves.toEqual([
      expect.objectContaining({ id: result.id, findingId: finding.id }),
    ]);
  });

  it('runs a generic command scenario for a finding without a deterministic rule adapter', async () => {
    const root = await temporaryRoot();
    const orchestrator = new SuccessfulReproductionOrchestrator(root);
    const reproducer = new SandboxVulnerabilityReproducer(
      root,
      new DurableStore(root),
      orchestrator,
      () => new Date('2026-07-20T15:00:00.000Z'),
    );
    const finding = { ...fixtureFinding(), id: 'generic-signal', ruleId: 'third-party-signal' };
    const plan = await reproducer.createPlan(finding, 'hawk-worker:test', {
      control: ['node', '-e', 'process.exit(1)'],
      reproduction: ['node', '-e', 'process.exit(0)'],
      controlExpectedExitCode: 0,
      reproductionExpectedExitCode: 0,
      label: 'generic behavioral probe',
    });

    expect(plan.mode).toBe('generic-sandbox');
    expect(plan.statement).toContain('approved offline scenario');
    const result = await reproducer.execute(finding, {
      planId: plan.id,
      planHash: plan.planHash,
      approved: true,
    });

    expect(result.status).toBe('reproduced');
    expect(orchestrator.spec?.tasks[1]?.title).toBe('Run generic negative control');
    expect(orchestrator.spec?.tasks[2]?.title).toContain('generic behavioral probe');
  });

  it('rejects a changed approval hash before starting Docker', async () => {
    const root = await temporaryRoot();
    const orchestrator = new SuccessfulReproductionOrchestrator(root);
    const reproducer = new SandboxVulnerabilityReproducer(
      root,
      new DurableStore(root),
      orchestrator,
    );
    const finding = fixtureFinding();
    const plan = await reproducer.createPlan(finding);

    await expect(
      reproducer.execute(finding, {
        planId: plan.id,
        planHash: '0'.repeat(64),
        approved: true,
      }),
    ).rejects.toThrow('hash does not match');
    expect(orchestrator.spec).toBeUndefined();
  });

  it('refuses unsupported or path-escaping findings', async () => {
    const root = await temporaryRoot();
    const reproducer = new SandboxVulnerabilityReproducer(
      root,
      new DurableStore(root),
      new SuccessfulReproductionOrchestrator(root),
    );
    await expect(
      reproducer.createPlan({ ...fixtureFinding(), ruleId: 'external-active-probe' }),
    ).rejects.toThrow('not available');
    await expect(
      reproducer.createPlan(
        { ...fixtureFinding(), ruleId: 'external-active-probe' },
        'hawk-worker:test',
        {
          control: ['bash', '-c', 'exit 1'],
          reproduction: ['node', '-e', 'process.exit(0)'],
        },
      ),
    ).rejects.toThrow('executable is not allowed');
    await expect(
      reproducer.createPlan({
        ...fixtureFinding(),
        source: { file: '../outside.ts', line: 1 },
      }),
    ).rejects.toThrow('trusted workspace');
    await expect(reproducer.createPlan(fixtureFinding(), '--privileged')).rejects.toThrow(
      'valid existing local Docker image',
    );
  });

  it('rejects source drift after the exact plan is approved', async () => {
    const root = await temporaryRoot();
    const orchestrator = new SuccessfulReproductionOrchestrator(root);
    const reproducer = new SandboxVulnerabilityReproducer(
      root,
      new DurableStore(root),
      orchestrator,
    );
    const finding = fixtureFinding();
    const plan = await reproducer.createPlan(finding);
    await writeFile(join(root, 'src', 'risky.ts'), 'eval(changedInput);\n');

    await expect(
      reproducer.execute(finding, {
        planId: plan.id,
        planHash: plan.planHash,
        approved: true,
      }),
    ).rejects.toThrow('source content changed');
    expect(orchestrator.spec).toBeUndefined();
  });
});

class SuccessfulReproductionOrchestrator {
  spec: OrchestrationSpec | undefined;
  private snapshot: OrchestrationSnapshot | undefined;

  constructor(private readonly root: string) {}

  async start(spec: OrchestrationSpec): Promise<OrchestrationSnapshot> {
    this.spec = spec;
    const sourceDigest = createHash('sha256')
      .update(readFileSync(join(this.root, 'src', 'risky.ts')))
      .digest('hex');
    const tasks = (['baseline', 'control', 'reproduction'] as const).map((id) =>
      terminalTask(id, this.root, sourceDigest),
    );
    this.snapshot = {
      protocolVersion: 2,
      id: 'run-reproduction-test',
      status: 'succeeded',
      image: spec.image,
      workspaceRoot: this.root,
      outputRoot: join(this.root, '.hawk', 'orchestrations', 'run-reproduction-test'),
      maxParallel: 1,
      cpuPerWorker: 0.5,
      memoryMbPerWorker: 256,
      artifactMbPerWorker: 32,
      networkMode: 'none',
      inheritedEnv: [],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cancelRequested: false,
      scheduler: {
        strategy: 'latency',
        leaseSeconds: 30,
        instances: [],
        decisions: [],
      },
      summary: {
        total: 3,
        pending: 0,
        running: 0,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      tasks,
    };
    return this.snapshot;
  }

  get(): OrchestrationSnapshot | undefined {
    return this.snapshot;
  }

  async shutdown(): Promise<void> {}
}

function terminalTask(
  id: 'baseline' | 'control' | 'reproduction',
  root: string,
  sourceDigest: string,
): OrchestrationTaskSnapshot {
  return {
    id,
    title: id,
    status: 'succeeded',
    dependsOn: id === 'baseline' ? [] : [id === 'control' ? 'baseline' : 'control'],
    attempt: 1,
    artifactDirectory: join(root, '.hawk', id),
    assignedInstanceId: 'reproduction-sandbox',
    reassignments: 0,
    durationMs: 5,
    output: JSON.stringify({
      gate: id,
      observed: true,
      digest: id === 'baseline' ? sourceDigest : 'a'.repeat(64),
    }),
  };
}

function fixtureFinding(): SecurityFinding {
  return {
    id: 'static-eval-test',
    ruleId: 'dynamic-code-execution',
    title: 'Dynamic code execution via eval',
    severity: 'high',
    status: 'suspected',
    confidence: 'signal',
    createdAt: '2026-07-20T15:00:00.000Z',
    description: 'eval signal',
    remediation: 'remove eval',
    evidence: [{ kind: 'code', summary: 'eval(...) call detected.' }],
    source: { file: 'src/risky.ts', line: 4 },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hawk-reproduction-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'risky.ts'), 'eval(untrustedInput);\n');
  return root;
}
