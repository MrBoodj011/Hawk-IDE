import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AiSessionManager } from './aiSessionManager.js';
import {
  HawkDockerOrchestrator,
  type OrchestrationSnapshot,
  type WorkerRuntime,
  type WorkerTaskContext,
  type WorkerTaskResult,
} from './orchestrator.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Hawk chaos and recovery invariants', () => {
  it('recovers a durable task after a worker crash and control-plane restart', async () => {
    const root = await temporaryWorkspace('hawk-chaos-orchestrator-');
    const crashed = new HungAfterStartRuntime();
    const first = new HawkDockerOrchestrator(root, crashed);
    const started = await first.start({
      image: 'hawk-worker:test',
      tasks: [
        {
          id: 'crash-survivor',
          title: 'Crash survivor',
          command: ['chaos', 'crash'],
          retries: 1,
        },
      ],
    });
    await waitForTaskStatus(first, started.id, 'running');

    // The run.json file is the hand-off boundary between daemon processes.
    // Read it before throwing away the first orchestrator to model SIGKILL.
    const durable = JSON.parse(
      await readFile(join(started.outputRoot, 'run.json'), 'utf8'),
    ) as OrchestrationSnapshot;
    expect(durable.status).toBe('running');
    expect(durable.tasks[0]).toMatchObject({ status: 'running', attempt: 1 });

    const recovery = new RecoverAfterRestartRuntime();
    const restarted = new HawkDockerOrchestrator(root, recovery);
    await restarted.initialize();
    const completed = await waitForTerminal(restarted, started.id);

    expect(completed.status).toBe('succeeded');
    expect(completed.tasks[0]).toMatchObject({
      id: 'crash-survivor',
      status: 'succeeded',
      attempt: 1,
      error: undefined,
    });
    expect(recovery.recovered).toEqual(['crash-survivor']);
  });

  it('turns a thrown network failure into a bounded retry instead of a stuck run', async () => {
    const root = await temporaryWorkspace('hawk-chaos-network-');
    const runtime = new NetworkFlapRuntime();
    const orchestrator = new HawkDockerOrchestrator(root, runtime);
    const started = await orchestrator.start({
      image: 'hawk-worker:test',
      tasks: [
        {
          id: 'network-flap',
          title: 'Network flap',
          command: ['chaos', 'network'],
          retries: 2,
        },
      ],
    });
    const completed = await waitForTerminal(orchestrator, started.id);

    expect(completed.status).toBe('succeeded');
    expect(runtime.attempts).toBe(2);
    expect(completed.tasks[0]).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      output: 'network recovered\n',
      error: undefined,
    });
  });

  it('retries a transient Docker failure while reattaching a crashed worker', async () => {
    const root = await temporaryWorkspace('hawk-chaos-recovery-network-');
    const first = new HawkDockerOrchestrator(root, new HungAfterStartRuntime());
    const started = await first.start({
      image: 'hawk-worker:test',
      tasks: [
        {
          id: 'recovery-network-flap',
          title: 'Recovery network flap',
          command: ['chaos', 'recovery-network'],
          retries: 1,
        },
      ],
    });
    await waitForTaskStatus(first, started.id, 'running');

    const runtime = new RecoveryNetworkFlapRuntime();
    const restarted = new HawkDockerOrchestrator(root, runtime);
    await restarted.initialize();
    const completed = await waitForTerminal(restarted, started.id);

    expect(completed.status).toBe('succeeded');
    expect(runtime.recoverAttempts).toBe(1);
    expect(runtime.runAttempts).toBe(1);
    expect(completed.tasks[0]).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      error: undefined,
    });
  });

  it('auto-resumes a background coding agent from its durable worktree after a crash', async () => {
    const root = await temporaryWorkspace('hawk-chaos-agent-');
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Chaos Test']);
    await git(root, ['config', 'user.email', 'hawk-chaos@localhost']);
    await writeFile(join(root, 'app.txt'), 'base\n', 'utf8');
    await git(root, ['add', 'app.txt']);
    await git(root, ['commit', '-m', 'base']);

    const worker = join(root, 'chaos-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', () => {",
        "  if (!fs.existsSync('.hawk-chaos-in-flight')) {",
        "    fs.writeFileSync('.hawk-chaos-in-flight', 'worker started');",
        '    setInterval(() => {}, 1000);',
        '    return;',
        '  }',
        "  fs.unlinkSync('.hawk-chaos-in-flight');",
        "  fs.appendFileSync('app.txt', 'recovered\\n');",
        "  console.log(JSON.stringify({ type: 'worker-result', ok: true }));",
        '});',
      ].join('\n'),
      'utf8',
    );

    const storageRoot = join(root, '.chaos-storage');
    const launch = { command: process.execPath, args: [worker] };
    const first = new AiSessionManager({ workspaceRoot: root, storageRoot, workerLaunch: launch });
    await first.initialize();
    const created = await first.create({
      prompt: 'Complete the recovery edit',
      background: true,
      autoResume: true,
    });
    const marker = join(created.sandboxPath ?? '', '.hawk-chaos-in-flight');
    await waitForPath(marker);

    // Dispose writes a clean paused state. Re-mark it as running to model the
    // last durable checkpoint that would remain if the host process were
    // killed before its shutdown handler ran.
    await first.dispose();
    const sessionFile = join(storageRoot, 'sessions', `${created.id}.json`);
    const persisted = JSON.parse(await readFile(sessionFile, 'utf8')) as Record<string, unknown>;
    persisted.status = 'running';
    persisted.error = undefined;
    await writeFile(sessionFile, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    const restarted = new AiSessionManager({
      workspaceRoot: root,
      storageRoot,
      workerLaunch: launch,
    });
    await restarted.initialize();
    try {
      const recovered = await waitForAiStatus(restarted, created.id, 'awaiting-review');
      expect(recovered.resumeCount).toBe(1);
      expect(recovered.diff).toMatchObject({ files: 1, insertions: 1 });
      expect(
        (await readFile(join(recovered.sandboxPath ?? '', 'app.txt'), 'utf8')).replaceAll(
          '\r\n',
          '\n',
        ),
      ).toBe('base\nrecovered\n');
      const events = await restarted.events(created.id);
      expect(events.events.map((event) => event.text)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('recovered this task after restart'),
          expect.stringContaining('Background task resumed automatically'),
        ]),
      );
      await restarted.reject(created.id);
    } finally {
      await restarted.dispose();
    }
  }, 20_000);
});

class HungAfterStartRuntime implements WorkerRuntime {
  async availability(): Promise<{ available: boolean; version: string }> {
    return { available: true, version: 'chaos-test' };
  }

  async run(): Promise<WorkerTaskResult> {
    return await new Promise<WorkerTaskResult>(() => undefined);
  }

  async cancel(): Promise<void> {}
}

class RecoverAfterRestartRuntime implements WorkerRuntime {
  readonly recovered: string[] = [];

  async availability(): Promise<{ available: boolean; version: string }> {
    return { available: true, version: 'chaos-test' };
  }

  async recover(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    this.recovered.push(context.task.id);
    return {
      exitCode: 0,
      output: 'recovered after restart\n',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async run(): Promise<WorkerTaskResult> {
    throw new Error('run should not be used when a retained worker is recoverable');
  }

  async cancel(): Promise<void> {}
}

class NetworkFlapRuntime implements WorkerRuntime {
  attempts = 0;

  async availability(): Promise<{ available: boolean; version: string }> {
    return { available: true, version: 'chaos-test' };
  }

  async run(): Promise<WorkerTaskResult> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error('ECONNRESET: simulated Docker/network socket failure');
    }
    return {
      exitCode: 0,
      output: 'network recovered\n',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async cancel(): Promise<void> {}
}

class RecoveryNetworkFlapRuntime implements WorkerRuntime {
  recoverAttempts = 0;
  runAttempts = 0;

  async availability(): Promise<{ available: boolean; version: string }> {
    return { available: true, version: 'chaos-test' };
  }

  async recover(): Promise<WorkerTaskResult | undefined> {
    this.recoverAttempts += 1;
    throw new Error('ECONNRESET: simulated recovery socket failure');
  }

  async run(): Promise<WorkerTaskResult> {
    this.runAttempts += 1;
    return {
      exitCode: 0,
      output: 'recovered after retry\n',
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async cancel(): Promise<void> {}
}

async function temporaryWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await stat(path)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for chaos marker: ${path}`);
}

async function waitForTerminal(
  orchestrator: HawkDockerOrchestrator,
  runId: string,
): Promise<OrchestrationSnapshot> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = orchestrator.get(runId, true);
    if (!run) throw new Error(`Run disappeared: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

async function waitForTaskStatus(
  orchestrator: HawkDockerOrchestrator,
  runId: string,
  status: OrchestrationSnapshot['tasks'][number]['status'],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (orchestrator.get(runId)?.tasks.some((task) => task.status === status)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Task did not reach ${status}: ${runId}`);
}

async function waitForAiStatus(
  manager: AiSessionManager,
  id: string,
  status: Awaited<ReturnType<AiSessionManager['get']>>['status'],
): Promise<Awaited<ReturnType<AiSessionManager['get']>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const session = await manager.get(id);
    if (session.status === status) return session;
    if (session.status === 'failed') throw new Error(session.error ?? 'AI chaos recovery failed');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for AI status ${status}`);
}
