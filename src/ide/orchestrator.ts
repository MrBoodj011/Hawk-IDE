import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import writeFileAtomic from 'write-file-atomic';
import {
  type DistributedAgentInstanceSpec,
  type DistributedScheduleStrategy,
  type DistributedSchedulerSnapshot,
  type DistributedTaskCandidate,
  createAgentInstances,
  recordAgentCompletion,
  releaseAgentLease,
  scheduleDistributedAgents,
} from './distributedScheduler.js';

const execFileAsync = promisify(execFile);
const MAX_TASKS = 64;
const MAX_PARALLEL = 32;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_GLOBAL_CPU = 64;
const MAX_GLOBAL_MEMORY_MB = 64 * 1024;
const MIN_ARTIFACT_MB = 32;
const MAX_ARTIFACT_MB = 4 * 1024;

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
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
  priority?: number;
  estimatedSeconds?: number;
}

export interface OrchestrationSpec {
  image: string;
  tasks: OrchestrationTaskSpec[];
  maxParallel?: number;
  cpuPerWorker?: number;
  memoryMbPerWorker?: number;
  artifactMbPerWorker?: number;
  networkMode?: 'none' | 'bridge';
  inheritEnv?: string[];
  approvedExternalAccess?: boolean;
  scheduleStrategy?: DistributedScheduleStrategy;
  leaseSeconds?: number;
  agentInstances?: DistributedAgentInstanceSpec[];
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
  assignedInstanceId?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  schedulingScore?: number;
  schedulingReasons?: string[];
  criticalPathSeconds?: number;
  reassignments: number;
  durationMs?: number;
  lastAttemptStartedAt?: string;
}

export interface OrchestrationSnapshot {
  protocolVersion: 2;
  id: string;
  status: OrchestrationStatus;
  image: string;
  workspaceRoot: string;
  outputRoot: string;
  maxParallel: number;
  cpuPerWorker: number;
  memoryMbPerWorker: number;
  artifactMbPerWorker: number;
  networkMode: 'none' | 'bridge';
  resolvedImage?: string;
  inheritedEnv: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequested: boolean;
  scheduler: DistributedSchedulerSnapshot;
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
  artifactMb: number;
  networkMode: 'none' | 'bridge';
  inheritEnv: string[];
  instanceId: string;
  leaseId: string;
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
  resolveImage?(image: string): Promise<string>;
  run(context: WorkerTaskContext): Promise<WorkerTaskResult>;
  recover?(context: WorkerTaskContext): Promise<WorkerTaskResult | undefined>;
  cancel(runId: string, taskId: string): Promise<void>;
  cleanupOrphans?(workspaceRoot: string, activeWorkers: Set<string>): Promise<void>;
}

interface InternalTask extends OrchestrationTaskSnapshot {
  spec: OrchestrationTaskSpec;
}

interface InternalRun {
  snapshot: Omit<OrchestrationSnapshot, 'summary' | 'tasks'>;
  tasks: Map<string, InternalTask>;
  active: Map<string, Promise<void>>;
  persisting: Promise<void>;
  durableSnapshot?: OrchestrationSnapshot;
}

export class HawkDockerOrchestrator {
  private readonly runs = new Map<string, InternalRun>();
  private readonly outputBase: string;
  private activeWorkers = 0;
  private activeCpu = 0;
  private activeMemoryMb = 0;

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

  async initialize(): Promise<void> {
    let directories: string[] = [];
    try {
      directories = (await readdir(this.outputBase, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
        .map((entry) => entry.name);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    for (const directory of directories) {
      try {
        const outputRoot = join(this.outputBase, directory);
        const [snapshot, persistedSpec] = await Promise.all([
          readJsonFile<OrchestrationSnapshot>(join(outputRoot, 'run.json')),
          readJsonFile<OrchestrationSpec>(join(outputRoot, 'spec.json')),
        ]);
        if (!snapshot || !persistedSpec || snapshot.id !== directory) continue;
        if (resolve(snapshot.workspaceRoot) !== this.workspaceRoot) continue;
        if (!isInside(resolve(snapshot.outputRoot), this.outputBase)) continue;
        const normalized = normalizeSpec(persistedSpec);
        const tasks = new Map<string, InternalTask>();
        for (const taskSnapshot of snapshot.tasks) {
          const spec = normalized.tasks.find((candidate) => candidate.id === taskSnapshot.id);
          if (!spec)
            throw new Error(`Persisted run ${snapshot.id} is missing task ${taskSnapshot.id}`);
          tasks.set(taskSnapshot.id, {
            ...taskSnapshot,
            reassignments: taskSnapshot.reassignments ?? 0,
            spec,
          });
        }
        const { summary: _summary, tasks: _tasks, ...runSnapshot } = snapshot;
        const run: InternalRun = {
          snapshot: {
            ...runSnapshot,
            protocolVersion: 2,
            artifactMbPerWorker: snapshot.artifactMbPerWorker ?? normalized.artifactMbPerWorker,
            resolvedImage: snapshot.resolvedImage ?? snapshot.image,
            scheduler:
              snapshot.scheduler ??
              createSchedulerSnapshot(
                normalized.maxParallel,
                normalized.cpuPerWorker,
                normalized.memoryMbPerWorker,
                normalized.scheduleStrategy,
                normalized.leaseSeconds,
                normalized.agentInstances,
              ),
          },
          tasks,
          active: new Map(),
          persisting: Promise.resolve(),
          durableSnapshot: snapshot,
        };
        this.runs.set(snapshot.id, run);
        if (isTerminalRun(snapshot.status)) continue;
        for (const task of tasks.values()) {
          if (task.status !== 'running') continue;
          task.reassignments ??= 0;
          let instance = run.snapshot.scheduler.instances.find(
            (candidate) => candidate.id === task.assignedInstanceId,
          );
          instance ??= run.snapshot.scheduler.instances[0];
          if (!instance) throw new Error(`Persisted run ${snapshot.id} has no agent instances`);
          task.assignedInstanceId = instance.id;
          task.leaseId ??= randomUUID();
          task.leaseExpiresAt = leaseExpiry(this.now(), run.snapshot.scheduler.leaseSeconds);
          if (instance && !instance.activeTaskIds.includes(task.id)) {
            instance.activeTaskIds.push(task.id);
          }
          this.reserveWorker(run);
          const recovery = this.recoverTask(run, task).finally(() => {
            run.active.delete(task.id);
            this.releaseWorker(run);
          });
          run.active.set(task.id, recovery);
        }
        void this.execute(run);
      } catch {
        // A corrupt or obsolete run remains on disk for operator inspection but is never executed.
      }
    }
    const activeWorkers = new Set(
      [...this.runs.values()].flatMap((run) =>
        [...run.tasks.values()]
          .filter((task) => task.status === 'running')
          .map((task) => containerNameFor(run.snapshot.id, task.id)),
      ),
    );
    await this.runtime.cleanupOrphans?.(this.workspaceRoot, activeWorkers).catch(() => undefined);
  }

  async start(spec: OrchestrationSpec): Promise<OrchestrationSnapshot> {
    const normalized = normalizeSpec(spec);
    const availability = await this.runtime.availability();
    if (!availability.available) {
      throw new Error(
        `Docker worker runtime is unavailable: ${availability.error ?? 'start Docker Desktop or the Docker daemon'}`,
      );
    }
    const resolvedImage = this.runtime.resolveImage
      ? await this.runtime.resolveImage(normalized.image)
      : normalized.image;
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
        reassignments: 0,
        spec: task,
      });
    }
    const run: InternalRun = {
      snapshot: {
        protocolVersion: 2,
        id,
        status: 'queued',
        image: normalized.image,
        workspaceRoot: this.workspaceRoot,
        outputRoot,
        maxParallel: normalized.maxParallel,
        cpuPerWorker: normalized.cpuPerWorker,
        memoryMbPerWorker: normalized.memoryMbPerWorker,
        artifactMbPerWorker: normalized.artifactMbPerWorker,
        networkMode: normalized.networkMode,
        resolvedImage,
        inheritedEnv: normalized.inheritEnv,
        createdAt,
        cancelRequested: false,
        scheduler: createSchedulerSnapshot(
          normalized.maxParallel,
          normalized.cpuPerWorker,
          normalized.memoryMbPerWorker,
          normalized.scheduleStrategy,
          normalized.leaseSeconds,
          normalized.agentInstances,
        ),
      },
      tasks,
      active: new Map(),
      persisting: Promise.resolve(),
    };
    this.runs.set(id, run);
    await writeFileAtomic(
      join(outputRoot, 'spec.json'),
      `${JSON.stringify(normalized, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        fsync: true,
      },
    );
    await chmod(join(outputRoot, 'spec.json'), 0o600).catch(() => undefined);
    await this.persist(run);
    void this.execute(run);
    return this.get(id) as OrchestrationSnapshot;
  }

  get(runId: string, includeOutput = false): OrchestrationSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const snapshot = run.durableSnapshot ? structuredClone(run.durableSnapshot) : snapshotOf(run);
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

  schedulerStatus(): {
    activeWorkers: number;
    reservedCpu: number;
    reservedMemoryMb: number;
    runs: Array<{
      runId: string;
      status: OrchestrationStatus;
      scheduler: DistributedSchedulerSnapshot;
    }>;
  } {
    return {
      activeWorkers: this.activeWorkers,
      reservedCpu: this.activeCpu,
      reservedMemoryMb: this.activeMemoryMb,
      runs: [...this.runs.values()].map((run) => ({
        runId: run.snapshot.id,
        status: run.snapshot.status,
        scheduler: structuredClone(run.snapshot.scheduler),
      })),
    };
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
    run.snapshot.startedAt ??= this.now().toISOString();
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
      const scheduleLimit = Math.max(0, run.snapshot.maxParallel - run.active.size);
      const decisions = scheduleDistributedAgents(
        ready.map((task) => schedulerCandidate(task, run)),
        [...run.tasks.values()].map((task) => schedulerCandidate(task, run)),
        run.snapshot.scheduler.instances,
        run.snapshot.scheduler.strategy,
        scheduleLimit,
      );
      for (const decision of decisions) {
        if (!this.canReserveWorker(run)) break;
        const task = run.tasks.get(decision.taskId);
        const instance = run.snapshot.scheduler.instances.find(
          (candidate) => candidate.id === decision.instanceId,
        );
        if (!task || !instance || task.status !== 'pending') continue;
        const leaseId = randomUUID();
        task.assignedInstanceId = instance.id;
        task.leaseId = leaseId;
        task.leaseExpiresAt = leaseExpiry(this.now(), run.snapshot.scheduler.leaseSeconds);
        task.schedulingScore = decision.score;
        task.schedulingReasons = decision.reasons;
        task.criticalPathSeconds = decision.criticalPathSeconds;
        task.reassignments = Math.max(0, task.attempt);
        instance.activeTaskIds.push(task.id);
        instance.lastAssignedAt = this.now().toISOString();
        run.snapshot.scheduler.decisions = [...run.snapshot.scheduler.decisions, decision].slice(
          -200,
        );
        this.reserveWorker(run);
        const execution = this.executeTask(run, task).finally(() => {
          run.active.delete(task.id);
          this.releaseWorker(run);
        });
        run.active.set(task.id, execution);
      }

      const pending = [...run.tasks.values()].filter((task) => task.status === 'pending');
      if (run.active.size === 0) {
        if (ready.length > 0 && decisions.length === 0 && this.canReserveWorker(run)) {
          for (const task of ready) {
            task.status = 'failed';
            task.error =
              'No healthy Docker agent instance satisfies the task capabilities and resource request';
            task.completedAt = this.now().toISOString();
          }
          await this.persist(run);
          continue;
        }
        if (ready.length > 0 && !this.canReserveWorker(run)) {
          await resourceDelay();
          continue;
        }
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

  private canReserveWorker(run: InternalRun): boolean {
    return (
      this.activeWorkers < MAX_PARALLEL &&
      this.activeCpu + run.snapshot.cpuPerWorker <= MAX_GLOBAL_CPU &&
      this.activeMemoryMb + run.snapshot.memoryMbPerWorker <= MAX_GLOBAL_MEMORY_MB
    );
  }

  private reserveWorker(run: InternalRun): void {
    this.activeWorkers += 1;
    this.activeCpu += run.snapshot.cpuPerWorker;
    this.activeMemoryMb += run.snapshot.memoryMbPerWorker;
  }

  private releaseWorker(run: InternalRun): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.activeCpu = Math.max(0, this.activeCpu - run.snapshot.cpuPerWorker);
    this.activeMemoryMb = Math.max(0, this.activeMemoryMb - run.snapshot.memoryMbPerWorker);
  }

  private async executeTask(run: InternalRun, task: InternalTask): Promise<void> {
    if (!task.assignedInstanceId || !task.leaseId) {
      throw new Error(`Task ${task.id} has no distributed agent lease`);
    }
    task.status = 'running';
    task.startedAt ??= this.now().toISOString();
    task.lastAttemptStartedAt = this.now().toISOString();
    task.attempt += 1;
    await mkdir(task.artifactDirectory, { recursive: true });
    await this.persist(run);
    const heartbeat = setInterval(
      () => {
        task.leaseExpiresAt = leaseExpiry(this.now(), run.snapshot.scheduler.leaseSeconds);
        void this.persist(run);
      },
      Math.max(5_000, Math.floor((run.snapshot.scheduler.leaseSeconds * 1_000) / 3)),
    );
    heartbeat.unref();
    try {
      const result = await this.runtime.run(this.taskContext(run, task));
      await this.applyTaskResult(run, task, result);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async recoverTask(run: InternalRun, task: InternalTask): Promise<void> {
    try {
      const result = this.runtime.recover
        ? await this.runtime.recover(this.taskContext(run, task))
        : undefined;
      if (result) {
        await this.applyTaskResult(run, task, result);
        return;
      }
      if (task.attempt <= (task.spec.retries ?? 0)) {
        task.status = 'pending';
        task.error = 'Worker container disappeared during restart; retry scheduled';
      } else {
        task.status = 'failed';
        task.error =
          'Worker container disappeared during restart and no idempotent retry was authorized';
        task.completedAt = this.now().toISOString();
      }
      this.releaseTaskAssignment(run, task);
      await this.persist(run);
    } catch (error) {
      task.status = 'failed';
      task.error = `Worker recovery failed: ${errorMessage(error)}`;
      task.completedAt = this.now().toISOString();
      this.releaseTaskAssignment(run, task);
      await this.persist(run);
    }
  }

  private releaseTaskAssignment(run: InternalRun, task: InternalTask): void {
    const instance = run.snapshot.scheduler.instances.find(
      (candidate) => candidate.id === task.assignedInstanceId,
    );
    if (instance) releaseAgentLease(instance, task.id);
    task.leaseExpiresAt = undefined;
  }

  private taskContext(run: InternalRun, task: InternalTask): WorkerTaskContext {
    if (!task.assignedInstanceId || !task.leaseId) {
      throw new Error(`Task ${task.id} has no distributed agent lease`);
    }
    return {
      runId: run.snapshot.id,
      workspaceRoot: this.workspaceRoot,
      outputDirectory: task.artifactDirectory,
      image: run.snapshot.resolvedImage ?? run.snapshot.image,
      cpu: run.snapshot.cpuPerWorker,
      memoryMb: run.snapshot.memoryMbPerWorker,
      artifactMb: run.snapshot.artifactMbPerWorker,
      networkMode: run.snapshot.networkMode,
      inheritEnv: run.snapshot.inheritedEnv,
      instanceId: task.assignedInstanceId,
      leaseId: task.leaseId,
      task: task.spec,
    };
  }

  private async applyTaskResult(
    run: InternalRun,
    task: InternalTask,
    result: WorkerTaskResult,
  ): Promise<void> {
    const instance = run.snapshot.scheduler.instances.find(
      (candidate) => candidate.id === task.assignedInstanceId,
    );
    const durationMs = Math.max(
      0,
      this.now().getTime() - Date.parse(task.lastAttemptStartedAt ?? task.startedAt ?? ''),
    );
    task.durationMs = Number.isFinite(durationMs) ? durationMs : 0;
    if (instance) {
      recordAgentCompletion(
        instance,
        task.id,
        task.durationMs,
        result.exitCode === 0 && !result.timedOut && !result.cancelled,
      );
    }
    task.leaseExpiresAt = undefined;
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
    const durableSnapshot = snapshotOf(run);
    const operation = async (): Promise<void> => {
      await mkdir(run.snapshot.outputRoot, { recursive: true });
      const file = join(run.snapshot.outputRoot, 'run.json');
      await writeFileAtomic(file, `${JSON.stringify(durableSnapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        fsync: true,
      });
      await chmod(file, 0o600).catch(() => undefined);
      run.durableSnapshot = durableSnapshot;
    };
    run.persisting = run.persisting.then(operation, operation);
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

  async resolveImage(image: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', image],
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        },
      );
      const identity = stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(identity)) {
        throw new Error('Docker returned an invalid image identity');
      }
      return identity;
    } catch (error) {
      throw new Error(
        `Hawk requires an existing local Docker image and never pulls implicitly: ${errorMessage(error)}`,
      );
    }
  }

  async run(context: WorkerTaskContext): Promise<WorkerTaskResult> {
    const containerName = containerNameFor(context.runId, context.task.id);
    const timeoutSeconds = context.task.timeoutSeconds ?? 3600;
    const args = [
      'run',
      '--pull=never',
      '--name',
      containerName,
      '--label',
      `hawk.run=${context.runId}`,
      '--label',
      `hawk.task=${context.task.id}`,
      '--label',
      `hawk.agent=${context.instanceId}`,
      '--label',
      `hawk.lease=${context.leaseId}`,
      '--label',
      'hawk.managed=true',
      '--label',
      `hawk.workspace=${workspaceLabel(context.workspaceRoot)}`,
      '--network',
      context.networkMode,
      '--read-only',
      '--user',
      '65532:65532',
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
      '--ulimit',
      'nofile=1024:1024',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=128m,uid=65532,gid=65532,mode=0700',
      '--tmpfs',
      `/output:rw,noexec,nosuid,size=${context.artifactMb}m,uid=65532,gid=65532,mode=0700`,
      '--mount',
      `type=bind,source=${context.workspaceRoot},target=/workspace,readonly`,
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
        void this.copyArtifacts(containerName, context.outputDirectory)
          .then(() => undefined)
          .catch((error) => `Hawk could not collect worker artifacts: ${errorMessage(error)}`)
          .then(async (artifactError) => {
            await this.removeContainer(containerName);
            finish({
              exitCode: artifactError ? -1 : (code ?? -1),
              output: '',
              outputTruncated,
              timedOut,
              cancelled: false,
              ...(artifactError ? { error: artifactError } : {}),
            });
          });
      });
    });
  }

  async recover(context: WorkerTaskContext): Promise<WorkerTaskResult | undefined> {
    const containerName = containerNameFor(context.runId, context.task.id);
    try {
      await execFileAsync('docker', ['inspect', containerName], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
    } catch {
      return undefined;
    }
    const timeoutSeconds = context.task.timeoutSeconds ?? 3600;
    let timedOut = false;
    let exitCode = -1;
    try {
      const result = await execFileAsync('docker', ['wait', containerName], {
        encoding: 'utf8',
        timeout: timeoutSeconds * 1_000,
        windowsHide: true,
      });
      exitCode = Number.parseInt(result.stdout.trim(), 10);
      if (!Number.isFinite(exitCode)) exitCode = -1;
    } catch (error) {
      timedOut = errorCode(error) === 'ETIMEDOUT';
      if (timedOut) await this.cancel(context.runId, context.task.id);
    }
    let output = '';
    let outputTruncated = false;
    try {
      const logs = await execFileAsync('docker', ['logs', containerName], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      output = `${logs.stdout}${logs.stderr}`;
      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
        output = Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
        outputTruncated = true;
      }
    } catch (error) {
      output = `Hawk could not recover complete worker logs: ${errorMessage(error)}`;
      outputTruncated = true;
    }
    try {
      await this.copyArtifacts(containerName, context.outputDirectory);
    } catch (error) {
      exitCode = -1;
      output = `${output}\nHawk could not collect worker artifacts: ${errorMessage(error)}`.trim();
    }
    await this.removeContainer(containerName);
    return {
      exitCode,
      output,
      outputTruncated,
      timedOut,
      cancelled: false,
      ...(timedOut ? { error: `Recovered worker exceeded ${timeoutSeconds} seconds` } : {}),
    };
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

  async cleanupOrphans(workspaceRoot: string, activeWorkers: Set<string>): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        [
          'ps',
          '--all',
          '--filter',
          'label=hawk.managed=true',
          '--filter',
          `label=hawk.workspace=${workspaceLabel(workspaceRoot)}`,
          '--format',
          '{{.Names}}',
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        },
      );
      const orphans = stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.startsWith('hawk-') && !activeWorkers.has(name));
      await Promise.all(orphans.map((name) => this.removeContainer(name)));
    } catch {
      // Docker may be offline during startup. A later initialization reconciles retained workers.
    }
  }

  private async copyArtifacts(containerName: string, outputDirectory: string): Promise<void> {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await execFileAsync('docker', ['cp', `${containerName}:/output/.`, outputDirectory], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
  }

  private async removeContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '--force', containerName], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
    } catch {
      // Container cleanup is best effort and recovery can reconcile a retained container.
    }
  }
}

type NormalizedOrchestrationSpec = Required<
  Pick<
    OrchestrationSpec,
    | 'image'
    | 'tasks'
    | 'maxParallel'
    | 'cpuPerWorker'
    | 'memoryMbPerWorker'
    | 'artifactMbPerWorker'
    | 'networkMode'
    | 'inheritEnv'
    | 'approvedExternalAccess'
    | 'scheduleStrategy'
    | 'leaseSeconds'
    | 'agentInstances'
  >
>;

function normalizeSpec(spec: OrchestrationSpec): NormalizedOrchestrationSpec {
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
    if (
      task.priority !== undefined &&
      (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100)
    )
      throw new Error(`Task ${task.id} priority must be an integer between 0 and 100`);
    if (
      task.estimatedSeconds !== undefined &&
      (!Number.isFinite(task.estimatedSeconds) ||
        task.estimatedSeconds < 1 ||
        task.estimatedSeconds > 86_400)
    )
      throw new Error(`Task ${task.id} estimatedSeconds must be between 1 and 86400`);
    validateCapabilities(task.requiredCapabilities, `Task ${task.id} requiredCapabilities`);
    validateCapabilities(task.preferredCapabilities, `Task ${task.id} preferredCapabilities`);
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
  const artifactMbPerWorker = spec.artifactMbPerWorker ?? 512;
  if (
    !Number.isInteger(artifactMbPerWorker) ||
    artifactMbPerWorker < MIN_ARTIFACT_MB ||
    artifactMbPerWorker > MAX_ARTIFACT_MB
  ) {
    throw new Error(
      `artifactMbPerWorker must be between ${MIN_ARTIFACT_MB} and ${MAX_ARTIFACT_MB}`,
    );
  }
  if (maxParallel * cpuPerWorker > MAX_GLOBAL_CPU) {
    throw new Error(`Parallel CPU reservation cannot exceed ${MAX_GLOBAL_CPU} cores`);
  }
  if (maxParallel * memoryMbPerWorker > MAX_GLOBAL_MEMORY_MB) {
    throw new Error(`Parallel memory reservation cannot exceed ${MAX_GLOBAL_MEMORY_MB} MB`);
  }
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
  const scheduleStrategy = spec.scheduleStrategy ?? 'balanced';
  if (!['balanced', 'latency', 'throughput'].includes(scheduleStrategy))
    throw new Error('scheduleStrategy must be balanced, latency, or throughput');
  const leaseSeconds = spec.leaseSeconds ?? 30;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 600)
    throw new Error('leaseSeconds must be an integer between 15 and 600');
  const agentInstances = normalizeAgentInstances(
    spec.agentInstances ?? [],
    maxParallel,
    cpuPerWorker,
    memoryMbPerWorker,
  );
  for (const task of spec.tasks) {
    const required = task.requiredCapabilities ?? [];
    if (
      required.length > 0 &&
      !agentInstances.some((instance) =>
        required.every((capability) => instance.capabilities?.includes(capability)),
      )
    ) {
      throw new Error(
        `No Docker agent instance satisfies task ${task.id} capabilities: ${required.join(', ')}`,
      );
    }
  }

  return {
    image: spec.image,
    tasks: spec.tasks.map((task) => ({
      ...task,
      dependsOn: [...new Set(task.dependsOn ?? [])],
      retries: task.retries ?? 0,
      timeoutSeconds: task.timeoutSeconds ?? 3600,
      requiredCapabilities: [...new Set(task.requiredCapabilities ?? [])],
      preferredCapabilities: [...new Set(task.preferredCapabilities ?? [])],
      priority: task.priority ?? 50,
      estimatedSeconds: task.estimatedSeconds ?? task.timeoutSeconds ?? 300,
    })),
    maxParallel,
    cpuPerWorker,
    memoryMbPerWorker,
    artifactMbPerWorker,
    networkMode,
    inheritEnv,
    approvedExternalAccess,
    scheduleStrategy,
    leaseSeconds,
    agentInstances,
  };
}

function normalizeAgentInstances(
  instances: DistributedAgentInstanceSpec[],
  maxParallel: number,
  cpuPerWorker: number,
  memoryMbPerWorker: number,
): DistributedAgentInstanceSpec[] {
  if (instances.length > MAX_PARALLEL)
    throw new Error(`A scheduler is limited to ${MAX_PARALLEL} Docker agent instances`);
  const defaults = ['general', 'code', 'security', 'test'];
  const source: DistributedAgentInstanceSpec[] =
    instances.length > 0
      ? instances
      : Array.from({ length: maxParallel }, (_, index) => ({
          id: `agent-${String(index + 1).padStart(2, '0')}`,
        }));
  const ids = new Set<string>();
  return source.map((instance) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instance.id))
      throw new Error(`Invalid Docker agent instance id: ${instance.id}`);
    if (ids.has(instance.id)) throw new Error(`Duplicate Docker agent instance: ${instance.id}`);
    ids.add(instance.id);
    validateCapabilities(instance.capabilities, `Agent ${instance.id} capabilities`);
    const maxConcurrent = instance.maxConcurrent ?? 1;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)
      throw new Error(`Agent ${instance.id} maxConcurrent must be between 1 and 8`);
    const cpuCapacity = instance.cpuCapacity ?? cpuPerWorker;
    if (!Number.isFinite(cpuCapacity) || cpuCapacity < cpuPerWorker || cpuCapacity > 8)
      throw new Error(`Agent ${instance.id} cpuCapacity cannot satisfy one worker`);
    const memoryMbCapacity = instance.memoryMbCapacity ?? memoryMbPerWorker;
    if (
      !Number.isInteger(memoryMbCapacity) ||
      memoryMbCapacity < memoryMbPerWorker ||
      memoryMbCapacity > 16_384
    )
      throw new Error(`Agent ${instance.id} memoryMbCapacity cannot satisfy one worker`);
    return {
      id: instance.id,
      capabilities: [...new Set(instance.capabilities?.length ? instance.capabilities : defaults)],
      maxConcurrent,
      cpuCapacity,
      memoryMbCapacity,
    };
  });
}

function validateCapabilities(capabilities: string[] | undefined, label: string): void {
  if ((capabilities?.length ?? 0) > 32) throw new Error(`${label} is limited to 32 values`);
  for (const capability of capabilities ?? []) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(capability))
      throw new Error(`${label} contains an invalid value: ${capability}`);
  }
}

function createSchedulerSnapshot(
  maxParallel: number,
  cpuPerWorker: number,
  memoryMbPerWorker: number,
  strategy: DistributedScheduleStrategy,
  leaseSeconds: number,
  specs: DistributedAgentInstanceSpec[],
): DistributedSchedulerSnapshot {
  return {
    strategy,
    leaseSeconds,
    instances: createAgentInstances(maxParallel, cpuPerWorker, memoryMbPerWorker, specs),
    decisions: [],
  };
}

function schedulerCandidate(task: InternalTask, run: InternalRun): DistributedTaskCandidate {
  return {
    id: task.id,
    dependsOn: task.dependsOn,
    requiredCapabilities: task.spec.requiredCapabilities ?? [],
    preferredCapabilities: task.spec.preferredCapabilities ?? [],
    priority: task.spec.priority ?? 50,
    estimatedSeconds: task.spec.estimatedSeconds ?? 300,
    cpu: run.snapshot.cpuPerWorker,
    memoryMb: run.snapshot.memoryMbPerWorker,
  };
}

function leaseExpiry(now: Date, leaseSeconds: number): string {
  return new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
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

function workspaceLabel(workspaceRoot: string): string {
  return createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 24);
}

async function resourceDelay(): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, 25);
  });
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

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isInside(candidate: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
