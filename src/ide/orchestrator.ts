import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TASKS = 64;
const MAX_PARALLEL = 32;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type OrchestrationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type OrchestrationTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface OrchestrationTaskSpec {
  id: string;
  title: string;
  command: string[];
  dependsOn?: string[];
  timeoutSeconds?: number;
  retries?: number;
}

export interface OrchestrationSpec {
  image: string;
  tasks: OrchestrationTaskSpec[];
  maxParallel?: number;
  cpuPerWorker?: number;
  memoryMbPerWorker?: number;
  networkMode?: 'none' | 'bridge';
  inheritEnv?: string[];
  approvedExternalAccess?: boolean;
}

export interface OrchestrationTaskSnapshot {
  id: string;
  title: string;
  status: OrchestrationTaskStatus;
  dependsOn: string[];
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  output?: string;
  outputTruncated?: boolean;
  artifactDirectory: string;
}

export interface OrchestrationSnapshot {
  protocolVersion: 1;
  id: string;
  status: OrchestrationStatus;
  image: string;
  workspaceRoot: string;
  outputRoot: string;
  maxParallel: number;
  cpuPerWorker: number;
  memoryMbPerWorker: number;
  networkMode: 'none' | 'bridge';
  inheritedEnv: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequested: boolean;
  summary: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
  };
  tasks: OrchestrationTaskSnapshot[];
}

export interface WorkerTaskContext {
  runId: string;
  workspaceRoot: string;
  outputDirectory: string;
  image: string;
  cpu: number;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  inheritEnv: string[];
  task: OrchestrationTaskSpec;
}

export interface WorkerTaskResult {
  exitCode: number;
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

export interface WorkerRuntime {
  availability(): Promise<{ available: boolean; version?: string; error?: string }>;
  run(context: WorkerTaskContext): Promise<WorkerTaskResult>;
  cancel(runId: string, taskId: string): Promise<void>;
}

interface InternalTask extends OrchestrationTaskSnapshot {
  spec: OrchestrationTaskSpec;
}

interface InternalRun {
  snapshot: Omit<OrchestrationSnapshot, 'summary' | 'tasks'>;
  tasks: Map<string, InternalTask>;
  active: Map<string, Promise<void>>;
  persisting: Promise<void>;
}

export class HawkDockerOrchestrator {
  private readonly runs = new Map<string, InternalRun>();
  private readonly outputBase: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly runtime: WorkerRuntime = new DockerWorkerRuntime(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.outputBase = join(this.workspaceRoot, '.hawk', 'orchestrations');
  }

  availability(): Promise<{ available: boolean; version?: string; error?: string }> {
    return this.runtime.availability();
  }

  async start(spec: OrchestrationSpec): Promise<OrchestrationSnapshot> {
    const normalized = normalizeSpec(spec);
    const availability = await this.runtime.availability();
    if (!availability.available) {
      throw new Error(
        `Docker worker runtime is unavailable: ${availability.error ?? 'start Docker Desktop or the Docker daemon'}`,
      );
    }
    const id = `run-${randomUUID()}`;
    const outputRoot = join(this.outputBase, id);
    await mkdir(outputRoot, { recursive: true });
    const createdAt = this.now().toISOString();
    const tasks = new Map<string, InternalTask>();
    for (const task of normalized.tasks) {
      tasks.set(task.id, {
        id: task.id,
        title: task.title,
        status: 'pending',
        dependsOn: task.dependsOn ?? [],
        attempt: 0,
        artifactDirectory: join(outputRoot, task.id),
        spec: task,
      });
    }
    const run: InternalRun = {
      snapshot: {
        protocolVersion: 1,
        id,
        status: 'queued',
        image: normalized.image,
        workspaceRoot: this.workspaceRoot,
        outputRoot,
        maxParallel: normalized.maxParallel,
        cpuPerWorker: normalized.cpuPerWorker,
        memoryMbPerWorker: normalized.memoryMbPerWorker,
        networkMode: normalized.networkMode,
        inheritedEnv: normalized.inheritEnv,
        createdAt,
        cancelRequested: false,
      },
      tasks,
      active: new Map(),
      persisting: Promise.resolve(),
    };
    this.runs.set(id, run);
    await this.persist(run);
    void this.execute(run);
    return snapshotOf(run);
  }

  get(runId: string, includeOutput = false): OrchestrationSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const snapshot = snapshotOf(run);
    if (!includeOutput) {
      snapshot.tasks = snapshot.tasks.map(({ output: _output, ...task }) => task);
    }
    return snapshot;
  }

  list(): OrchestrationSnapshot[] {
    return [...this.runs.values()]
      .map((run) => this.get(run.snapshot.id) as OrchestrationSnapshot)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async cancel(runId: string): Promise<OrchestrationSnapshot> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    if (isTerminalRun(run.snapshot.status)) return snapshotOf(run);
    run.snapshot.cancelRequested = true;
    for (const task of run.tasks.values()) {
      if (task.status === 'pending') {
        task.status = 'cancelled';
        task.completedAt = this.now().toISOString();
      }
    }
    await Promise.allSettled(
      [...run.tasks.values()]
        .filter((task) => task.status === 'running')
        .map((task) => this.runtime.cancel(run.snapshot.id, task.id)),
    );
    await this.persist(run);
    return snapshotOf(run);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runs.values()]
        .filter((run) => !isTerminalRun(run.snapshot.status))
        .map((run) => this.cancel(run.snapshot.id)),
    );
  }

  private async execute(run: InternalRun): Promise<void> {
    run.snapshot.status = 'running';
    run.snapshot.startedAt = this.now().toISOString();
    await this.persist(run);

    while (true) {
      this.skipTasksWithFailedDependencies(run);
      if (run.snapshot.cancelRequested) {
        if (run.active.size === 0) break;
        await Promise.race(run.active.values());
        continue;
      }

      const ready = [...run.tasks.values()].filter(
        (task) =>
          task.status === 'pending' &&
          task.dependsOn.every((dependency) => run.tasks.get(dependency)?.status === 'succeeded'),
      );
      while (ready.length > 0 && run.active.size < run.snapshot.maxParallel) {
        const task = ready.shift();
        if (!task) break;
        const execution = this.executeTask(run, task).finally(() => {
          run.active.delete(task.id);
        });
        run.active.set(task.id, execution);
      }

      const pending = [...run.tasks.values()].filter((task) => task.status === 'pending');
      if (run.active.size === 0) {
        if (pending.length > 0) {
          for (const task of pending) {
            task.status = 'skipped';
            task.error = 'Dependency graph could not make progress';
            task.completedAt = this.now().toISOString();
          }
        }
        break;
      }
      await Promise.race(run.active.values());
    }

    if (run.snapshot.cancelRequested) run.snapshot.status = 'cancelled';
    else if ([...run.tasks.values()].some((task) => task.status === 'failed'))
      run.snapshot.status = 'failed';
    else run.snapshot.status = 'succeeded';
    run.snapshot.completedAt = this.now().toISOString();
    await this.persist(run);
  }

  private async executeTask(run: InternalRun, task: InternalTask): Promise<void> {
    task.status = 'running';
    task.startedAt ??= this.now().toISOString();
    task.attempt += 1;
    await mkdir(task.artifactDirectory, { recursive: true });
    await this.persist(run);

    const result = await this.runtime.run({
      runId: run.snapshot.id,
      workspaceRoot: this.workspaceRoot,
      outputDirectory: task.artifactDirectory,
      image: run.snapshot.image,
      cpu: run.snapshot.cpuPerWorker,
      memoryMb: run.snapshot.memoryMbPerWorker,
      networkMode: run.snapshot.networkMode,
      inheritEnv: run.snapshot.inheritedEnv,
      task: task.spec,
    });
    task.output = result.output;
    task.outputTruncated = result.outputTruncated;
    task.exitCode = result.exitCode;
    if (run.snapshot.cancelRequested || result.cancelled) {
      task.status = 'cancelled';
      task.error = result.error ?? 'Cancelled by operator';
      task.completedAt = this.now().toISOString();
      await this.persist(run);
      return;
    }
    if (result.exitCode === 0 && !result.timedOut) {
      task.status = 'succeeded';
      task.completedAt = this.now().toISOString();
      await this.persist(run);
      return;
    }
    if (task.attempt <= (task.spec.retries ?? 0)) {
      task.status = 'pending';
      task.error = result.error ?? `Worker exited with code ${result.exitCode}; retrying`;
      await this.persist(run);
      return;
    }
    task.status = 'failed';
    task.error =
      result.error ??
      (result.timedOut
        ? `Worker exceeded ${task.spec.timeoutSeconds ?? 3600} seconds`
        : `Worker exited with code ${result.exitCode}`);
    task.completedAt = this.now().toISOString();
    await this.persist(run);
  }

  private skipTasksWithFailedDependencies(run: InternalRun): void {
    for (const task of run.tasks.values()) {
      if (task.status !== 'pending') continue;
      const failedDependency = task.dependsOn.find((dependency) => {
        const status = run.tasks.get(dependency)?.status;
        return status === 'failed' || status === 'skipped' || status === 'cancelled';
      });
      if (!failedDependency) continue;
      task.status = 'skipped';
      task.error = `Dependency ${failedDependency} did not succeed`;
      task.completedAt = this.now().toISOString();
    }
  }

  private async persist(run: InternalRun): Promise<void> {
    run.persisting = run.persisting.then(async () => {
      await mkdir(run.snapshot.outputRoot, { recursive: true });
      await writeFile(
        join(run.snapshot.outputRoot, 'run.json'),
        `${JSON.stringify(snapshotOf(run), null, 2)}\n`,
        'utf8',
      );
    });
    await run.persisting;
  }
}

export class DockerWorkerRuntime implements WorkerRuntime {
  async availability(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      const version = stdout.trim();
      return version
        ? { available: true, version }
        : { available: false, error: 'Docker returned no server version' };
    } catch (err) {
      return { available: false, error: errorMessage(err) };
    }
  }

  async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    const containerName = containerNameFor(context.runId, context.task.id);
    const timeoutSeconds = context.task.timeoutSeconds ?? 3600;
    const args = [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      containerName,
      '--label',
      `hawk.run=${context.runId}`,
      '--label',
      `hawk.task=${context.task.id}`,
      '--network',
      context.networkMode,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--cpus',
      String(context.cpu),
      '--memory',
      `${context.memoryMb}m`,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=128m',
      '--mount',
      `type=bind,source=${context.workspaceRoot},target=/workspace,readonly`,
      '--mount',
      `type=bind,source=${context.outputDirectory},target=/output`,
      '--workdir',
      '/workspace',
      '--env',
      'HAWK_WORKSPACE=/workspace',
      '--env',
      'HAWK_OUTPUT_DIR=/output',
    ];
    for (const name of context.inheritEnv) args.push('--env', name);
    args.push(context.image, ...context.task.command);

    return await new Promise<WorkerTaskResult>((resolveTask) => {
      const child = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let settled = false;

      const collect = (chunk: Buffer): void => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          outputTruncated = true;
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - bytes;
        const accepted = chunk.subarray(0, remaining);
        chunks.push(accepted);
        bytes += accepted.byteLength;
        if (accepted.byteLength < chunk.byteLength) outputTruncated = true;
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timer = setTimeout(() => {
        timedOut = true;
        void this.cancel(context.runId, context.task.id);
      }, timeoutSeconds * 1000);
      timer.unref();

      const finish = (result: WorkerTaskResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveTask({
          ...result,
          output: Buffer.concat(chunks).toString('utf8'),
          outputTruncated,
          timedOut,
        });
      };
      child.once('error', (err) => {
        finish({
          exitCode: -1,
          output: '',
          outputTruncated,
          timedOut,
          cancelled: false,
          error: errorMessage(err),
        });
      });
      child.once('close', (code) => {
        finish({
          exitCode: code ?? -1,
          output: '',
          outputTruncated,
          timedOut,
          cancelled: false,
        });
      });
    });
  }

  async cancel(runId: string, taskId: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '--force', containerNameFor(runId, taskId)], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
    } catch {
      // The worker may have completed between status inspection and cancellation.
    }
  }
}

function normalizeSpec(
  spec: OrchestrationSpec,
): Required<
  Pick<
    OrchestrationSpec,
    | 'image'
    | 'tasks'
    | 'maxParallel'
    | 'cpuPerWorker'
    | 'memoryMbPerWorker'
    | 'networkMode'
    | 'inheritEnv'
    | 'approvedExternalAccess'
  >
> {
  if (!isSafeImageName(spec.image)) throw new Error('Docker image name is invalid');
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0)
    throw new Error('At least one worker task is required');
  if (spec.tasks.length > MAX_TASKS) throw new Error(`A run is limited to ${MAX_TASKS} tasks`);

  const ids = new Set<string>();
  for (const task of spec.tasks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(task.id))
      throw new Error(`Invalid task id: ${task.id}`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!task.title.trim() || task.title.length > 160)
      throw new Error(`Task ${task.id} needs a title below 160 characters`);
    if (!Array.isArray(task.command) || task.command.length === 0 || task.command.length > 64)
      throw new Error(`Task ${task.id} needs a command array with 1-64 arguments`);
    if (task.command.some((argument) => !argument || argument.length > 4096))
      throw new Error(`Task ${task.id} has an invalid command argument`);
    if (
      task.timeoutSeconds !== undefined &&
      (task.timeoutSeconds < 10 || task.timeoutSeconds > 43_200)
    )
      throw new Error(`Task ${task.id} timeout must be between 10 and 43200 seconds`);
    if (task.retries !== undefined && (task.retries < 0 || task.retries > 3))
      throw new Error(`Task ${task.id} retries must be between 0 and 3`);
  }
  for (const task of spec.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency))
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
    }
  }

  const defaultParallel = Math.max(1, Math.min(cpus().length || 1, spec.tasks.length, 8));
  const maxParallel = spec.maxParallel ?? defaultParallel;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL)
    throw new Error(`maxParallel must be an integer between 1 and ${MAX_PARALLEL}`);
  const cpuPerWorker = spec.cpuPerWorker ?? 1;
  if (cpuPerWorker < 0.25 || cpuPerWorker > 8)
    throw new Error('cpuPerWorker must be between 0.25 and 8');
  const memoryMbPerWorker = spec.memoryMbPerWorker ?? 1024;
  if (!Number.isInteger(memoryMbPerWorker) || memoryMbPerWorker < 128 || memoryMbPerWorker > 16_384)
    throw new Error('memoryMbPerWorker must be between 128 and 16384');
  const networkMode = spec.networkMode ?? 'none';
  if (networkMode !== 'none' && networkMode !== 'bridge')
    throw new Error('networkMode must be none or bridge');
  const inheritEnv = [...new Set(spec.inheritEnv ?? [])];
  if (inheritEnv.length > 16) throw new Error('A run can inherit at most 16 environment names');
  for (const name of inheritEnv) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))
      throw new Error(`Invalid inherited environment name: ${name}`);
    if (process.env[name] === undefined)
      throw new Error(`Inherited environment variable is not set: ${name}`);
  }
  const approvedExternalAccess = spec.approvedExternalAccess ?? false;
  if ((networkMode !== 'none' || inheritEnv.length > 0) && !approvedExternalAccess) {
    throw new Error(
      'approvedExternalAccess must be true when enabling container network or inherited credentials',
    );
  }

  return {
    image: spec.image,
    tasks: spec.tasks.map((task) => ({
      ...task,
      dependsOn: [...new Set(task.dependsOn ?? [])],
      retries: task.retries ?? 0,
      timeoutSeconds: task.timeoutSeconds ?? 3600,
    })),
    maxParallel,
    cpuPerWorker,
    memoryMbPerWorker,
    networkMode,
    inheritEnv,
    approvedExternalAccess,
  };
}

function snapshotOf(run: InternalRun): OrchestrationSnapshot {
  const tasks = [...run.tasks.values()].map(({ spec: _spec, ...task }) => ({ ...task }));
  const count = (status: OrchestrationTaskStatus): number =>
    tasks.filter((task) => task.status === status).length;
  return {
    ...run.snapshot,
    summary: {
      total: tasks.length,
      pending: count('pending'),
      running: count('running'),
      succeeded: count('succeeded'),
      failed: count('failed'),
      skipped: count('skipped'),
      cancelled: count('cancelled'),
    },
    tasks,
  };
}

function containerNameFor(runId: string, taskId: string): string {
  const safe = `hawk-${runId.slice(4, 12)}-${taskId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  return safe.slice(0, 63);
}

function isSafeImageName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value) &&
    !value.includes('..')
  );
}

function isTerminalRun(status: OrchestrationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
