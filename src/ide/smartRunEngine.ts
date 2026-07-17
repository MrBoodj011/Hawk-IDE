import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DurableStore } from './durableStore.js';
import type { ProofGraph } from './proofGraph.js';
import { stableHash } from './scopePolicy.js';
import type {
  GoalSpec,
  HawkPlan,
  PlanApproval,
  PolicyEvaluation,
  SmartRun,
  SmartRunEvent,
  SmartRunNode,
  SmartRunNodeStatus,
} from './smartTypes.js';

export interface CapabilityExecutionContext {
  goal: GoalSpec;
  plan: HawkPlan;
  run: SmartRun;
  node: SmartRunNode;
  input: unknown;
  signal: AbortSignal;
}

export interface CapabilityExecutionResult {
  output: unknown;
  summary: string;
}

export type CapabilityExecutor = (
  context: CapabilityExecutionContext,
) => Promise<CapabilityExecutionResult>;

export class SmartRunEngine {
  private readonly runs = new Map<string, SmartRun>();
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly eventListeners = new Set<(event: SmartRunEvent) => void | Promise<void>>();
  private readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly store: DurableStore,
    private readonly graph: ProofGraph,
    private readonly executor: CapabilityExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    const persisted = await this.store.listJson<SmartRun>('runs');
    for (const run of persisted) {
      this.runs.set(run.id, run);
      if (run.status !== 'queued' && run.status !== 'running') continue;
      for (const node of run.nodes) {
        if (node.status !== 'running') continue;
        node.status = 'pending';
        node.error = 'Recovered after an interrupted worker lease';
      }
      run.status = 'queued';
      run.lease = undefined;
      await this.record(run, 'run.recovered', { owner: this.owner });
      this.launch(run.id);
    }
  }

  async start(
    goal: GoalSpec,
    plan: HawkPlan,
    policy: PolicyEvaluation,
    approval: PlanApproval | undefined,
    executionInputs: Record<string, unknown> = {},
  ): Promise<SmartRun> {
    if (policy.decision === 'deny')
      throw new Error(`Policy denied plan: ${policy.reasons.join('; ')}`);
    if (policy.decision === 'require-approval' && approval?.planHash !== plan.planHash)
      throw new Error('This plan requires a valid approval bound to its exact hash');
    const existing = [...this.runs.values()].find(
      (run) =>
        run.planHash === plan.planHash &&
        run.status !== 'failed' &&
        run.status !== 'cancelled' &&
        run.status !== 'succeeded',
    );
    if (existing) return clone(existing);
    const timestamp = this.now().toISOString();
    const nodes: SmartRunNode[] = plan.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      capabilityId: node.capabilityId,
      status: 'pending',
      dependsOn: [...node.dependsOn],
      attempt: 0,
    }));
    const run: SmartRun = summarize({
      protocolVersion: 1,
      id: `smart-run-${randomUUID()}`,
      goalId: goal.id,
      planId: plan.id,
      planHash: plan.planHash,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      pauseRequested: false,
      cancelRequested: false,
      executionInputs: sanitizeExecutionInputs(executionInputs),
      eventCount: 0,
      lastEventHash: 'genesis',
      nodes,
      summary: emptySummary(nodes.length),
    });
    this.runs.set(run.id, run);
    await this.record(run, 'run.created', {
      planId: plan.id,
      planHash: plan.planHash,
      maxParallel: plan.maxParallel,
    });
    this.launch(run.id);
    return clone(run);
  }

  get(runId: string): SmartRun | undefined {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  list(): SmartRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async settled(runId: string): Promise<void> {
    await this.activeExecutions.get(runId);
  }

  onEvent(listener: (event: SmartRunEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async events(runId: string, limit = 1_000): Promise<SmartRunEvent[]> {
    if (!this.runs.has(runId)) throw new Error(`Unknown smart run: ${runId}`);
    const events = await this.store.readJsonLines<SmartRunEvent>('run-events', runId, limit);
    verifyEventChain(events);
    return events;
  }

  async control(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<SmartRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown smart run: ${runId}`);
    if (isTerminal(run.status)) return clone(run);
    if (action === 'pause') {
      run.pauseRequested = true;
      run.status = 'paused';
      await this.record(run, 'run.paused', { owner: this.owner });
    } else if (action === 'resume') {
      run.pauseRequested = false;
      run.status = 'queued';
      await this.record(run, 'run.resumed', { owner: this.owner });
      this.launch(run.id);
    } else {
      run.cancelRequested = true;
      for (const node of run.nodes) {
        this.controllers.get(controllerKey(run.id, node.id))?.abort();
      }
      for (const node of run.nodes) {
        if (node.status === 'pending') node.status = 'cancelled';
      }
      await this.record(run, 'run.cancel-requested', { owner: this.owner });
    }
    return clone(run);
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      run.status = 'queued';
      run.lease = undefined;
      await this.record(run, 'run.lease-released', { owner: this.owner });
    }
  }

  private launch(runId: string): void {
    if (this.activeExecutions.has(runId)) return;
    const execution = this.execute(runId).finally(() => this.activeExecutions.delete(runId));
    this.activeExecutions.set(runId, execution);
  }

  private async execute(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status) || run.pauseRequested) return;
    const goal = await this.store.readJson<GoalSpec>('goals', run.goalId);
    const plan = await this.store.readJson<HawkPlan>('plans', run.planId);
    if (!goal || !plan) {
      run.status = 'failed';
      await this.record(run, 'run.failed', { error: 'Goal or plan snapshot is missing' });
      return;
    }
    run.status = 'running';
    run.startedAt ??= this.now().toISOString();
    this.renewLease(run);
    await this.record(run, 'run.started', { owner: this.owner });
    const active = new Map<string, Promise<void>>();

    while (!run.pauseRequested && !run.cancelRequested) {
      skipBlockedNodes(run);
      const ready = run.nodes.filter(
        (node) =>
          node.status === 'pending' &&
          node.dependsOn.every(
            (dependency) =>
              run.nodes.find((candidate) => candidate.id === dependency)?.status === 'succeeded',
          ),
      );
      while (ready.length > 0 && active.size < plan.maxParallel) {
        const node = ready.shift();
        if (!node) break;
        const promise = this.executeNode(goal, plan, run, node).finally(() =>
          active.delete(node.id),
        );
        active.set(node.id, promise);
      }
      if (active.size === 0) break;
      await Promise.race(active.values());
      this.renewLease(run);
    }

    if (active.size > 0) await Promise.allSettled(active.values());
    if (run.cancelRequested) {
      for (const node of run.nodes) {
        if (node.status === 'pending' || node.status === 'running') node.status = 'cancelled';
      }
      run.status = 'cancelled';
      run.completedAt = this.now().toISOString();
      run.lease = undefined;
      await this.record(run, 'run.cancelled', {});
      return;
    }
    if (run.pauseRequested) {
      run.status = 'paused';
      run.lease = undefined;
      await this.record(run, 'run.paused', {});
      return;
    }
    if (run.nodes.some((node) => node.status === 'failed')) run.status = 'failed';
    else if (run.nodes.every((node) => node.status === 'succeeded')) run.status = 'succeeded';
    else run.status = 'failed';
    run.completedAt = this.now().toISOString();
    run.lease = undefined;
    await this.record(run, `run.${run.status}`, {});
  }

  private async executeNode(
    goal: GoalSpec,
    plan: HawkPlan,
    run: SmartRun,
    node: SmartRunNode,
  ): Promise<void> {
    const spec = plan.nodes.find((candidate) => candidate.id === node.id);
    if (!spec) throw new Error(`Plan node disappeared: ${node.id}`);
    node.status = 'running';
    node.startedAt ??= this.now().toISOString();
    node.attempt += 1;
    const controller = new AbortController();
    this.controllers.set(controllerKey(run.id, node.id), controller);
    await this.record(run, 'node.started', {
      nodeId: node.id,
      capabilityId: node.capabilityId,
      attempt: node.attempt,
    });
    try {
      if (controller.signal.aborted || run.cancelRequested)
        throw new Error('Capability was cancelled');
      const result = await withTimeout(
        this.executor({
          goal,
          plan,
          run: clone(run),
          node: { ...node },
          input: run.executionInputs[node.capabilityId],
          signal: controller.signal,
        }),
        spec.timeoutSeconds * 1_000,
        controller,
      );
      if (controller.signal.aborted) throw new Error('Capability was cancelled');
      const artifactId = `${run.id}--${node.id}`;
      await this.store.writeJson('artifacts', artifactId, {
        protocolVersion: 1,
        runId: run.id,
        nodeId: node.id,
        capabilityId: node.capabilityId,
        summary: result.summary.slice(0, 1_000),
        output: result.output,
        createdAt: this.now().toISOString(),
      });
      node.status = 'succeeded';
      node.completedAt = this.now().toISOString();
      node.artifactUri = `hawk://run/${run.id}/artifact/${node.id}`;
      node.resultDigest = stableHash(result.output);
      node.error = undefined;
      await this.graph.upsertNode(run.id, 'run', run.id, { status: run.status });
      await this.graph.upsertNode(`tool-${node.capabilityId}`, 'tool', node.capabilityId, {
        capability: node.capabilityId,
      });
      await this.graph.connect(`tool-${node.capabilityId}`, run.id, 'executed-in');
      await this.record(run, 'node.succeeded', {
        nodeId: node.id,
        artifactUri: node.artifactUri,
        resultDigest: node.resultDigest,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (controller.signal.aborted || run.cancelRequested) {
        node.status = 'cancelled';
        node.completedAt = this.now().toISOString();
        node.error = message;
        await this.record(run, 'node.cancelled', { nodeId: node.id, error: message });
        return;
      }
      if (node.attempt <= spec.retries) {
        node.status = 'pending';
        node.error = `${message}; retry scheduled`;
        await this.record(run, 'node.retrying', {
          nodeId: node.id,
          attempt: node.attempt,
          error: message,
        });
        return;
      }
      node.status = 'failed';
      node.completedAt = this.now().toISOString();
      node.error = message;
      await this.record(run, 'node.failed', { nodeId: node.id, error: message });
    } finally {
      this.controllers.delete(controllerKey(run.id, node.id));
    }
  }

  private renewLease(run: SmartRun): void {
    const heartbeat = this.now();
    run.lease = {
      owner: this.owner,
      heartbeatAt: heartbeat.toISOString(),
      expiresAt: new Date(heartbeat.getTime() + 30_000).toISOString(),
    };
  }

  private async record(run: SmartRun, type: string, data: Record<string, unknown>): Promise<void> {
    const eventBase = {
      protocolVersion: 1 as const,
      runId: run.id,
      sequence: run.eventCount + 1,
      type,
      at: this.now().toISOString(),
      data,
      previousHash: run.lastEventHash,
    };
    const event: SmartRunEvent = { ...eventBase, hash: stableHash(eventBase) };
    run.eventCount = event.sequence;
    run.lastEventHash = event.hash;
    run.updatedAt = event.at;
    summarize(run);
    await this.store.appendJsonLine('run-events', run.id, event);
    await this.store.writeJson('runs', run.id, run);
    for (const listener of this.eventListeners) {
      void Promise.resolve(listener(event)).catch(() => undefined);
    }
  }
}

function skipBlockedNodes(run: SmartRun): void {
  for (const node of run.nodes) {
    if (node.status !== 'pending') continue;
    const blockedBy = node.dependsOn.find((dependency) => {
      const status = run.nodes.find((candidate) => candidate.id === dependency)?.status;
      return status === 'failed' || status === 'skipped' || status === 'cancelled';
    });
    if (!blockedBy) continue;
    node.status = 'skipped';
    node.error = `Dependency ${blockedBy} did not succeed`;
  }
}

function summarize(run: SmartRun): SmartRun {
  const count = (status: SmartRunNodeStatus): number =>
    run.nodes.filter((node) => node.status === status).length;
  run.summary = {
    total: run.nodes.length,
    pending: count('pending'),
    running: count('running'),
    succeeded: count('succeeded'),
    failed: count('failed'),
    skipped: count('skipped'),
    cancelled: count('cancelled'),
  };
  return run;
}

function emptySummary(total: number): SmartRun['summary'] {
  return {
    total,
    pending: total,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
}

function sanitizeExecutionInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(inputs);
  if (entries.length > 32) throw new Error('Execution inputs are limited to 32 capabilities');
  const serialized = JSON.stringify(inputs);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024)
    throw new Error('Execution inputs exceed the 256 KB limit');
  if (/(?:password|secret|token|api[_-]?key)"?\s*:/i.test(serialized))
    throw new Error(
      'Pass credential names through approved environment references, not execution inputs',
    );
  return JSON.parse(serialized) as Record<string, unknown>;
}

function isTerminal(status: SmartRun['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Capability exceeded ${milliseconds} ms`));
        }, milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verifyEventChain(events: SmartRunEvent[]): void {
  if (events.length === 0) return;
  let previousHash = events[0]?.previousHash ?? 'genesis';
  let previousSequence = (events[0]?.sequence ?? 1) - 1;
  for (const event of events) {
    const { hash, ...base } = event;
    if (event.previousHash !== previousHash || event.sequence !== previousSequence + 1)
      throw new Error(`Run event chain is discontinuous at sequence ${event.sequence}`);
    if (stableHash(base) !== hash)
      throw new Error(`Run event integrity check failed at sequence ${event.sequence}`);
    previousHash = hash;
    previousSequence = event.sequence;
  }
}

function controllerKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
