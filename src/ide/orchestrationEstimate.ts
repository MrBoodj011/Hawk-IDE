export interface EstimatedTask {
  id: string;
  estimatedMinutes: number;
  dependsOn?: string[];
}

export interface ParallelEstimate {
  taskCount: number;
  maxParallel: number;
  totalWorkerMinutes: number;
  criticalPathMinutes: number;
  theoreticalLowerBoundMinutes: number;
  estimatedFloorWithStartupMinutes: number;
  theoreticalSpeedup: number;
  parallelizable: boolean;
  note: string;
}

export function estimateParallelExecution(
  tasks: EstimatedTask[],
  maxParallel: number,
  startupSecondsPerTask = 3,
): ParallelEstimate {
  if (tasks.length === 0) throw new Error('At least one estimated task is required');
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32)
    throw new Error('maxParallel must be an integer between 1 and 32');
  const byId = new Map<string, EstimatedTask>();
  for (const task of tasks) {
    if (!task.id || byId.has(task.id)) throw new Error(`Duplicate or empty task id: ${task.id}`);
    if (!Number.isFinite(task.estimatedMinutes) || task.estimatedMinutes <= 0)
      throw new Error(`Task ${task.id} needs a positive estimated duration`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!byId.has(dependency))
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  const criticalTo = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`Dependency cycle contains task ${id}`);
    visiting.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown estimated task: ${id}`);
    const dependencyPath = Math.max(
      0,
      ...(task.dependsOn ?? []).map((dependency) => criticalTo(dependency)),
    );
    visiting.delete(id);
    const duration = dependencyPath + task.estimatedMinutes;
    memo.set(id, duration);
    return duration;
  };

  const totalWorkerMinutes = tasks.reduce((total, task) => total + task.estimatedMinutes, 0);
  const criticalPathMinutes = Math.max(...tasks.map((task) => criticalTo(task.id)));
  const boundedParallel = Math.min(maxParallel, tasks.length);
  const theoreticalLowerBoundMinutes = Math.max(
    criticalPathMinutes,
    totalWorkerMinutes / boundedParallel,
  );
  const startupMinutes = (tasks.length * startupSecondsPerTask) / 60 / boundedParallel;
  const estimatedFloorWithStartupMinutes = theoreticalLowerBoundMinutes + startupMinutes;
  const theoreticalSpeedup = totalWorkerMinutes / estimatedFloorWithStartupMinutes;

  return {
    taskCount: tasks.length,
    maxParallel: boundedParallel,
    totalWorkerMinutes: round(totalWorkerMinutes),
    criticalPathMinutes: round(criticalPathMinutes),
    theoreticalLowerBoundMinutes: round(theoreticalLowerBoundMinutes),
    estimatedFloorWithStartupMinutes: round(estimatedFloorWithStartupMinutes),
    theoreticalSpeedup: round(theoreticalSpeedup),
    parallelizable: criticalPathMinutes < totalWorkerMinutes,
    note: 'This is a scheduling floor, not a promise. Shared CPU, disk, model rate limits, API budgets, dependencies, and duplicated work can reduce real speedup.',
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
