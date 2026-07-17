import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableMcpTaskStore } from './durableMcpTaskStore.js';
import { DurableStore } from './durableStore.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DurableMcpTaskStore', () => {
  it('persists cancellation and notifies the run bridge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hawk-mcp-task-store-'));
    directories.push(directory);
    const statuses: string[] = [];
    const store = new DurableMcpTaskStore(
      new DurableStore(directory),
      () => new Date('2026-07-17T12:00:00.000Z'),
      async (taskId, status) => {
        statuses.push(`${taskId}:${status}`);
      },
    );
    const task = await store.createTask({ ttl: 60_000, context: { hawkPlanId: 'plan-1' } }, 1, {
      method: 'tools/call',
      params: { name: 'hawk_run_execute_task', arguments: { plan_id: 'plan-1' } },
    } as Request);

    await store.updateTaskStatus(task.taskId, 'cancelled', 'Cancelled by test');
    expect((await store.getTask(task.taskId))?.status).toBe('cancelled');
    expect(statuses).toEqual([`${task.taskId}:cancelled`]);
    await expect(store.storeTaskResult(task.taskId, 'completed', { content: [] })).rejects.toThrow(
      /already cancelled/i,
    );
  });
});
