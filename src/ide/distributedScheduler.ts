export type DistributedScheduleStrategy = 'balanced' | 'latency' | 'throughput';

export interface DistributedAgentInstanceSpec {
  id: string;
  capabilities?: string[];
  maxConcurrent?: number;
  cpuCapacity?: number;
  memoryMbCapacity?: number;
}

export interface DistributedAgentInstanceSnapshot {
  id: string;
  capabilities: string[];
  maxConcurrent: number;
  cpuCapacity: number;
  memoryMbCapacity: number;
  activeTaskIds: string[];
  completedTasks: number;
  failedTasks: number;
  averageDurationMs: number;
  healthy: boolean;
  lastAssignedAt?: string;
}

export interface DistributedTaskCandidate {
  id: string;
  dependsOn: string[];
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  priority: number;
  estimatedSeconds: number;
  cpu: number;
  memoryMb: number;
}

export interface DistributedScheduleDecision {
  taskId: string;
  instanceId: string;
  score: number;
  reasons: string[];
  criticalPathSeconds: number;
}

export interface DistributedSchedulerSnapshot {
  strategy: DistributedScheduleStrategy;
  leaseSeconds: number;
  instances: DistributedAgentInstanceSnapshot[];
  decisions: DistributedScheduleDecision[];
}

const DEFAULT_CAPABILITIES = ['general', 'code', 'security', 'test'];

export function createAgentInstances(
  maxParallel: number,
  cpuPerWorker: number,
  memoryMbPerWorker: number,
  specs: DistributedAgentInstanceSpec[] = [],
): DistributedAgentInstanceSnapshot[] {
  const normalized: DistributedAgentInstanceSpec[] =
    specs.length > 0
      ? specs
      : Array.from({ length: maxParallel }, (_, index) => ({
          id: `agent-${String(index + 1).padStart(2, '0')}`,
        }));
  return normalized.map((spec) => ({
    id: spec.id,
    capabilities: unique(spec.capabilities?.length ? spec.capabilities : DEFAULT_CAPABILITIES),
    maxConcurrent: Math.max(1, Math.min(8, Math.floor(spec.maxConcurrent ?? 1))),
    cpuCapacity: Math.max(cpuPerWorker, spec.cpuCapacity ?? cpuPerWorker),
    memoryMbCapacity: Math.max(memoryMbPerWorker, spec.memoryMbCapacity ?? memoryMbPerWorker),
    activeTaskIds: [],
    completedTasks: 0,
    failedTasks: 0,
    averageDurationMs: 0,
    healthy: true,
  }));
}

/**
 * Chooses the best currently available Docker agent for each ready DAG node.
 * Tasks are ranked by priority and remaining critical-path cost. Agents are
 * scored by hard capability/resource fit, preferred capability affinity,
 * current load, observed reliability, and historical duration.
 */
export function scheduleDistributedAgents(
  ready: DistributedTaskCandidate[],
  allTasks: DistributedTaskCandidate[],
  instances: DistributedAgentInstanceSnapshot[],
  strategy: DistributedScheduleStrategy,
  limit: number,
): DistributedScheduleDecision[] {
  const critical = criticalPathRanks(allTasks);
  const ordered = [...ready].sort(
    (left, right) =>
      right.priority - left.priority ||
      (critical.get(right.id) ?? 0) - (critical.get(left.id) ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const virtual = instances.map((instance) => ({
    ...instance,
    activeTaskIds: [...instance.activeTaskIds],
  }));
  const decisions: DistributedScheduleDecision[] = [];
  for (const task of ordered) {
    if (decisions.length >= Math.max(0, limit)) break;
    const eligible = virtual
      .filter((instance) => canRun(task, instance))
      .map((instance) => scoreInstance(task, instance, strategy, critical.get(task.id) ?? 0))
      .sort(
        (left, right) =>
          right.score - left.score || left.instance.id.localeCompare(right.instance.id),
      );
    const selected = eligible[0];
    if (!selected) continue;
    selected.instance.activeTaskIds.push(task.id);
    decisions.push({
      taskId: task.id,
      instanceId: selected.instance.id,
      score: Number(selected.score.toFixed(3)),
      reasons: selected.reasons,
      criticalPathSeconds: critical.get(task.id) ?? task.estimatedSeconds,
    });
  }
  return decisions;
}

export function recordAgentCompletion(
  instance: DistributedAgentInstanceSnapshot,
  taskId: string,
  durationMs: number,
  succeeded: boolean,
): void {
  instance.activeTaskIds = instance.activeTaskIds.filter((id) => id !== taskId);
  if (succeeded) instance.completedTasks += 1;
  else instance.failedTasks += 1;
  const observations = instance.completedTasks + instance.failedTasks;
  const boundedDuration = Math.max(0, Math.min(durationMs, 24 * 60 * 60 * 1_000));
  instance.averageDurationMs =
    observations <= 1
      ? boundedDuration
      : Math.round(instance.averageDurationMs * 0.75 + boundedDuration * 0.25);
  instance.healthy =
    instance.failedTasks < 3 ||
    instance.completedTasks > instance.failedTasks ||
    instance.failedTasks / Math.max(1, observations) < 0.6;
}

export function releaseAgentLease(
  instance: DistributedAgentInstanceSnapshot,
  taskId: string,
): void {
  instance.activeTaskIds = instance.activeTaskIds.filter((id) => id !== taskId);
}

function canRun(
  task: DistributedTaskCandidate,
  instance: DistributedAgentInstanceSnapshot,
): boolean {
  const capabilities = new Set(instance.capabilities);
  return (
    instance.healthy &&
    instance.activeTaskIds.length < instance.maxConcurrent &&
    task.cpu * (instance.activeTaskIds.length + 1) <= instance.cpuCapacity &&
    task.memoryMb * (instance.activeTaskIds.length + 1) <= instance.memoryMbCapacity &&
    task.requiredCapabilities.every((capability) => capabilities.has(capability))
  );
}

function scoreInstance(
  task: DistributedTaskCandidate,
  instance: DistributedAgentInstanceSnapshot,
  strategy: DistributedScheduleStrategy,
  criticalPathSeconds: number,
): {
  instance: DistributedAgentInstanceSnapshot;
  score: number;
  reasons: string[];
} {
  const capabilities = new Set(instance.capabilities);
  const preferred = task.preferredCapabilities.filter((capability) =>
    capabilities.has(capability),
  ).length;
  const observations = instance.completedTasks + instance.failedTasks;
  const failureRate = observations > 0 ? instance.failedTasks / observations : 0;
  const load = instance.activeTaskIds.length / instance.maxConcurrent;
  const speedPenalty = instance.averageDurationMs > 0 ? instance.averageDurationMs / 60_000 : 0;
  const strategyWeight =
    strategy === 'latency'
      ? -speedPenalty * 5 - load * 45
      : strategy === 'throughput'
        ? -load * 20
        : -speedPenalty * 2 - load * 32;
  const score =
    100 +
    task.priority * 8 +
    Math.min(40, criticalPathSeconds / 10) +
    preferred * 12 -
    failureRate * 70 +
    strategyWeight;
  const reasons = [
    `${task.requiredCapabilities.length} required capabilities matched`,
    `${preferred} preferred capabilities matched`,
    `load ${instance.activeTaskIds.length}/${instance.maxConcurrent}`,
    observations > 0
      ? `observed success ${Math.round((1 - failureRate) * 100)}%`
      : 'no failure history',
    `critical path ${criticalPathSeconds}s`,
  ];
  return { instance, score, reasons };
}

function criticalPathRanks(tasks: DistributedTaskCandidate[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      const values = dependents.get(dependency) ?? [];
      values.push(task.id);
      dependents.set(dependency, values);
    }
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return byId.get(id)?.estimatedSeconds ?? 1;
    visiting.add(id);
    const task = byId.get(id);
    const tail = Math.max(0, ...(dependents.get(id) ?? []).map(visit));
    const total = Math.max(1, task?.estimatedSeconds ?? 1) + tail;
    visiting.delete(id);
    memo.set(id, total);
    return total;
  };
  for (const task of tasks) visit(task.id);
  return memo;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 32);
}
