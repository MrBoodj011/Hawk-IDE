import { describe, expect, it } from 'vitest';
import {
  createAgentInstances,
  recordAgentCompletion,
  scheduleDistributedAgents,
} from './distributedScheduler.js';

describe('distributed Docker agent scheduler', () => {
  it('places capability-specific tasks on matching healthy instances', () => {
    const instances = createAgentInstances(2, 1, 1024, [
      { id: 'code-agent', capabilities: ['code', 'test'] },
      { id: 'security-agent', capabilities: ['security', 'traffic'] },
    ]);
    const tasks = [
      candidate('audit', ['security'], [], 5, 30),
      candidate('patch', ['code'], ['test'], 4, 60),
    ];

    const decisions = scheduleDistributedAgents(tasks, tasks, instances, 'balanced', 2);

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'audit', instanceId: 'security-agent' }),
        expect.objectContaining({ taskId: 'patch', instanceId: 'code-agent' }),
      ]),
    );
  });

  it('prioritizes the longest remaining critical path and avoids unhealthy workers', () => {
    const instances = createAgentInstances(2, 1, 1024, [
      { id: 'slow-failing', capabilities: ['general'] },
      { id: 'healthy', capabilities: ['general'] },
    ]);
    const failing = instances[0];
    if (!failing) throw new Error('missing fixture instance');
    recordAgentCompletion(failing, 'old-1', 100_000, false);
    recordAgentCompletion(failing, 'old-2', 100_000, false);
    recordAgentCompletion(failing, 'old-3', 100_000, false);
    const tasks = [
      candidate('short', ['general'], [], 1, 5),
      candidate('critical', ['general'], [], 1, 30),
      { ...candidate('report', ['general'], [], 1, 40), dependsOn: ['critical'] },
    ];

    const decisions = scheduleDistributedAgents(
      tasks.filter((task) => task.id !== 'report'),
      tasks,
      instances,
      'latency',
      1,
    );

    expect(decisions[0]).toMatchObject({
      taskId: 'critical',
      instanceId: 'healthy',
      criticalPathSeconds: 70,
    });
  });

  it('does not overcommit an instance CPU or memory capacity', () => {
    const instances = createAgentInstances(2, 1, 1024, [
      {
        id: 'bounded',
        capabilities: ['general'],
        maxConcurrent: 2,
        cpuCapacity: 1,
        memoryMbCapacity: 1024,
      },
      {
        id: 'spare',
        capabilities: ['general'],
        maxConcurrent: 1,
        cpuCapacity: 1,
        memoryMbCapacity: 1024,
      },
    ]);
    const tasks = [
      candidate('first', ['general'], [], 1, 10),
      candidate('second', ['general'], [], 1, 10),
    ];

    const decisions = scheduleDistributedAgents(tasks, tasks, instances, 'throughput', 2);

    expect(new Set(decisions.map((decision) => decision.instanceId))).toEqual(
      new Set(['bounded', 'spare']),
    );
  });
});

function candidate(
  id: string,
  requiredCapabilities: string[],
  preferredCapabilities: string[],
  priority: number,
  estimatedSeconds: number,
) {
  return {
    id,
    dependsOn: [],
    requiredCapabilities,
    preferredCapabilities,
    priority,
    estimatedSeconds,
    cpu: 1,
    memoryMb: 1024,
  };
}
