import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  });
});

class FakeRuntime implements WorkerRuntime {
  active = 0;
  maxActive = 0;
  readonly started: string[] = [];

  constructor(private readonly failures = new Set<string>()) {}

  async availability(): Promise<{ available: boolean; version?: string }> {
    return { available: true, version: 'test' };
  }

  async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(context.task.id);
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
