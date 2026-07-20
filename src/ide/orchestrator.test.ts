import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HawkDockerOrchestrator,
  type OrchestrationSnapshot,
  type WorkerRuntime,
  type WorkerTaskContext,
  type WorkerTaskResult,
} from './orchestrator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('HawkDockerOrchestrator', () => {
  it('runs an isolated dependency graph with bounded parallelism', async () => {
    const root = await temporaryWorkspace();
    const runtime = new FakeRuntime();
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const started = await orchestrator.start({
      image: 'hawk-worker:test',
      maxParallel: 2,
      tasks: [
        { id: 'routes', title: 'Map routes', command: ['scan', 'routes'] },
        { id: 'audit', title: 'Audit code', command: ['scan', 'audit'] },
        {
          id: 'report',
          title: 'Build report',
          command: ['report'],
          dependsOn: ['routes', 'audit'],
        },
      ],
    });

    const completed = await waitForTerminal(orchestrator, started.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.summary).toMatchObject({
      total: 3,
      succeeded: 3,
      failed: 0,
      skipped: 0,
    });
    expect(runtime.maxActive).toBe(2);
    expect(new Set(runtime.started.slice(0, 2))).toEqual(new Set(['routes', 'audit']));
    expect(runtime.started[2]).toBe('report');
    const persisted = JSON.parse(
      await readFile(join(completed.outputRoot, 'run.json'), 'utf8'),
    ) as OrchestrationSnapshot;
    expect(persisted.status).toBe('succeeded');
  });

  it('skips dependent work after a worker failure', async () => {
    const root = await temporaryWorkspace();
    const runtime = new FakeRuntime(new Set(['audit']));
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const started = await orchestrator.start({
      image: 'hawk-worker:test',
      tasks: [
        { id: 'audit', title: 'Audit code', command: ['scan'] },
        {
          id: 'report',
          title: 'Build report',
          command: ['report'],
          dependsOn: ['audit'],
        },
      ],
    });

    const completed = await waitForTerminal(orchestrator, started.id);
    expect(completed.status).toBe('failed');
    expect(completed.tasks.find((task) => task.id === 'audit')?.status).toBe('failed');
    expect(completed.tasks.find((task) => task.id === 'report')).toMatchObject({
      status: 'skipped',
      error: 'Dependency audit did not succeed',
    });
  });

  it('rejects invalid or excessive worker plans before execution', async () => {
    const root = await temporaryWorkspace();
    const orchestrator = new HawkDockerOrchestrator(root, new FakeRuntime());
    await expect(
      orchestrator.start({
        image: 'hawk-worker:test',
        tasks: [{ id: '../escape', title: 'Invalid', command: ['scan'] }],
      }),
    ).rejects.toThrow('Invalid task id');
    await expect(
      orchestrator.start({
        image: 'hawk-worker:test',
        maxParallel: 32,
        cpuPerWorker: 8,
        tasks: [{ id: 'valid', title: 'Too much CPU', command: ['scan'] }],
      }),
    ).rejects.toThrow('CPU reservation');
    await expect(
      orchestrator.start({
        image: 'hawk-worker:test',
        artifactMbPerWorker: 8,
        tasks: [{ id: 'valid', title: 'Tiny output quota', command: ['scan'] }],
      }),
    ).rejects.toThrow('artifactMbPerWorker');
  });

  it('refuses workspace persistence when .hawk is replaced by a file', async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, '.hawk'), 'attacker-controlled path');
    const orchestrator = new HawkDockerOrchestrator(root, new FakeRuntime());
    await expect(
      orchestrator.start({
        image: 'hawk-worker:test',
        tasks: [{ id: 'safe', title: 'Safe task', command: ['scan'] }],
      }),
    ).rejects.toThrow('Hawk persistence path is not a directory');
  });

  it('governs resources across concurrent runs and pins the resolved image identity', async () => {
    const root = await temporaryWorkspace();
    const runtime = new ResolvingRuntime();
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const tasks = Array.from({ length: 4 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      command: ['scan'],
    }));
    const first = await orchestrator.start({
      image: 'hawk-worker:mutable',
      maxParallel: 4,
      memoryMbPerWorker: 16_384,
      tasks,
    });
    const second = await orchestrator.start({
      image: 'hawk-worker:mutable',
      maxParallel: 4,
      memoryMbPerWorker: 16_384,
      tasks,
    });
    await Promise.all([
      waitForTerminal(orchestrator, first.id),
      waitForTerminal(orchestrator, second.id),
    ]);
    expect(runtime.maxActive).toBeLessThanOrEqual(4);
    expect(runtime.images).toEqual(expect.arrayContaining([`sha256:${'a'.repeat(64)}`]));
    expect(orchestrator.get(first.id)).toMatchObject({
      image: 'hawk-worker:mutable',
      resolvedImage: `sha256:${'a'.repeat(64)}`,
      artifactMbPerWorker: 512,
    });
  });

  it('restores history and reattaches a running worker after an MCP restart', async () => {
    const root = await temporaryWorkspace();
    const first = new HawkDockerOrchestrator(root, new HangingRuntime());
    const started = await first.start({
      image: 'hawk-worker:test',
      tasks: [{ id: 'long-task', title: 'Long task', command: ['scan', 'all'] }],
    });
    await waitForTaskStatus(first, started.id, 'running');

    const recoveryRuntime = new RecoveryRuntime();
    const restored = new HawkDockerOrchestrator(root, recoveryRuntime);
    await restored.initialize();
    const completed = await waitForTerminal(restored, started.id);

    expect(completed.status).toBe('succeeded');
    expect(completed.tasks[0]).toMatchObject({ id: 'long-task', status: 'succeeded' });
    expect(recoveryRuntime.recovered).toEqual(['long-task']);
    expect(recoveryRuntime.started).toEqual([]);
    expect(recoveryRuntime.cleanupCalls).toHaveLength(1);
    expect([...(recoveryRuntime.cleanupCalls[0] ?? [])]).toEqual([expect.stringMatching(/^hawk-/)]);
  });

  it('assigns specialized tasks to capability-matched Docker agent instances', async () => {
    const root = await temporaryWorkspace();
    const runtime = new FakeRuntime();
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const started = await orchestrator.start({
      image: 'hawk-worker:test',
      maxParallel: 2,
      scheduleStrategy: 'latency',
      agentInstances: [
        { id: 'code-agent', capabilities: ['code', 'test'] },
        { id: 'security-agent', capabilities: ['security', 'traffic'] },
      ],
      tasks: [
        {
          id: 'audit',
          title: 'Audit',
          command: ['audit'],
          requiredCapabilities: ['security'],
          priority: 90,
        },
        {
          id: 'patch',
          title: 'Patch',
          command: ['patch'],
          requiredCapabilities: ['code'],
          preferredCapabilities: ['test'],
        },
      ],
    });

    const completed = await waitForTerminal(orchestrator, started.id);
    expect(completed.status).toBe('succeeded');
    expect(runtime.assignments).toEqual(
      expect.arrayContaining([
        ['audit', 'security-agent'],
        ['patch', 'code-agent'],
      ]),
    );
    expect(completed.scheduler.decisions).toHaveLength(2);
    expect(completed.tasks.every((task) => Boolean(task.leaseId))).toBe(true);
  });

  it('rebalances an authorized retry away from an agent that just failed', async () => {
    const root = await temporaryWorkspace();
    const runtime = new FailOnceRuntime();
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const started = await orchestrator.start({
      image: 'hawk-worker:test',
      maxParallel: 1,
      scheduleStrategy: 'latency',
      agentInstances: [
        { id: 'agent-a', capabilities: ['general'] },
        { id: 'agent-b', capabilities: ['general'] },
      ],
      tasks: [
        {
          id: 'retryable',
          title: 'Retryable analysis',
          command: ['analyze'],
          requiredCapabilities: ['general'],
          retries: 1,
        },
      ],
    });

    const completed = await waitForTerminal(orchestrator, started.id);
    expect(completed.status).toBe('succeeded');
    expect(runtime.assignments).toEqual([
      ['retryable', 'agent-a'],
      ['retryable', 'agent-b'],
    ]);
    expect(completed.tasks[0]).toMatchObject({
      attempt: 2,
      reassignments: 1,
      assignedInstanceId: 'agent-b',
    });
  });
});

class FakeRuntime implements WorkerRuntime {
  active = 0;
  maxActive = 0;
  readonly started: string[] = [];
  readonly assignments: Array<[string, string]> = [];

  constructor(private readonly failures = new Set<string>()) {}

  async availability(): Promise<{ available: boolean; version?: string }> {
    return { available: true, version: 'test' };
  }

  async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(context.task.id);
    this.assignments.push([context.task.id, context.instanceId]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    this.active -= 1;
    const failed = this.failures.has(context.task.id);
    return {
      exitCode: failed ? 1 : 0,
      output: `${context.task.id}\n`,
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async cancel(): Promise<void> {}
}

class HangingRuntime implements WorkerRuntime {
  async availability(): Promise<{ available: boolean; version?: string }> {
    return { available: true, version: 'test' };
  }

  async run(): Promise<WorkerTaskResult> {
    return await new Promise<WorkerTaskResult>(() => undefined);
  }

  async cancel(): Promise<void> {}
}

class RecoveryRuntime extends FakeRuntime {
  readonly recovered: string[] = [];
  readonly cleanupCalls: Array<Set<string>> = [];

  override async recover(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.recovered.push(context.task.id);
    return {
      exitCode: 0,
      output: 'recovered worker output',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async cleanupOrphans(_workspaceRoot: string, activeWorkers: Set<string>): Promise<void> {
    this.cleanupCalls.push(new Set(activeWorkers));
  }
}

class ResolvingRuntime extends FakeRuntime {
  readonly images: string[] = [];

  async resolveImage(): Promise<string> {
    return `sha256:${'a'.repeat(64)}`;
  }

  override async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.images.push(context.image);
    return await super.run(context);
  }
}

class FailOnceRuntime extends FakeRuntime {
  private calls = 0;

  override async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.calls += 1;
    if (this.calls > 1) return await super.run(context);
    this.assignments.push([context.task.id, context.instanceId]);
    return {
      exitCode: 1,
      output: 'transient failure',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }
}

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hawk-orchestrator-'));
  roots.push(root);
  return root;
}

async function waitForTerminal(
  orchestrator: HawkDockerOrchestrator,
  runId: string,
): Promise<OrchestrationSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = orchestrator.get(runId, true);
    if (!run) throw new Error(`Run disappeared: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')
      return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

async function waitForTaskStatus(
  orchestrator: HawkDockerOrchestrator,
  runId: string,
  status: OrchestrationSnapshot['tasks'][number]['status'],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (orchestrator.get(runId)?.tasks.some((task) => task.status === status)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Task did not reach ${status}: ${runId}`);
}
