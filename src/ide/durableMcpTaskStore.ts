import { randomUUID } from 'node:crypto';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import type { DurableStore } from './durableStore.js';

interface StoredMcpTask {
  task: Task;
  result?: Result;
  requestId: RequestId;
  requestMethod: string;
  context?: Record<string, unknown>;
}

export type McpTaskStatusListener = (
  taskId: string,
  status: Task['status'],
) => Promise<void> | void;

export class DurableMcpTaskStore implements TaskStore {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
    private readonly onStatusChange: McpTaskStatusListener = () => undefined,
  ) {}

  async createTask(
    taskParams: {
      ttl?: number | null;
      pollInterval?: number;
      context?: Record<string, unknown>;
    },
    requestId: RequestId,
    request: Request,
  ): Promise<Task> {
    const timestamp = this.now().toISOString();
    const task: Task = {
      taskId: `mcp-task-${randomUUID()}`,
      status: 'working',
      ttl: taskParams.ttl ?? 86_400_000,
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      pollInterval: Math.max(250, taskParams.pollInterval ?? 1_000),
    };
    await this.store.writeJson<StoredMcpTask>('mcp-tasks', task.taskId, {
      task,
      requestId,
      requestMethod: request.method,
      context: taskParams.context,
    });
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const stored = await this.read(taskId);
    return stored ? { ...stored.task } : null;
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
  ): Promise<void> {
    const stored = await this.require(taskId);
    if (isTerminal(stored.task.status))
      throw new Error(`MCP task ${taskId} is already ${stored.task.status}`);
    stored.task.status = status;
    stored.task.lastUpdatedAt = this.now().toISOString();
    stored.result = result;
    await this.store.writeJson('mcp-tasks', taskId, stored);
  }

  async getTaskResult(taskId: string): Promise<Result> {
    const stored = await this.require(taskId);
    if (!stored.result) throw new Error(`MCP task ${taskId} has no result yet`);
    return stored.result;
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
  ): Promise<void> {
    const stored = await this.require(taskId);
    if (isTerminal(stored.task.status))
      throw new Error(`MCP task ${taskId} is already ${stored.task.status}`);
    stored.task.status = status;
    stored.task.lastUpdatedAt = this.now().toISOString();
    if (statusMessage) stored.task.statusMessage = statusMessage.slice(0, 1_000);
    await this.store.writeJson('mcp-tasks', taskId, stored);
    await this.onStatusChange(taskId, status);
  }

  async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const all = (await this.store.listJson<StoredMcpTask>('mcp-tasks'))
      .filter((stored) => !expired(stored.task, this.now()))
      .sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt));
    const start = cursor
      ? Math.max(0, all.findIndex((item) => item.task.taskId === cursor) + 1)
      : 0;
    const page = all.slice(start, start + 50);
    const nextCursor = start + page.length < all.length ? page.at(-1)?.task.taskId : undefined;
    return {
      tasks: page.map((stored) => ({ ...stored.task })),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async records(): Promise<
    Array<{ task: Task; result?: Result; context?: Record<string, unknown> }>
  > {
    return (await this.store.listJson<StoredMcpTask>('mcp-tasks'))
      .filter((stored) => !expired(stored.task, this.now()))
      .map((stored) => ({
        task: { ...stored.task },
        result: stored.result,
        context: stored.context,
      }));
  }

  private async read(taskId: string): Promise<StoredMcpTask | undefined> {
    const stored = await this.store.readJson<StoredMcpTask>('mcp-tasks', taskId);
    return stored && !expired(stored.task, this.now()) ? stored : undefined;
  }

  private async require(taskId: string): Promise<StoredMcpTask> {
    const stored = await this.read(taskId);
    if (!stored) throw new Error(`Unknown or expired MCP task: ${taskId}`);
    return stored;
  }
}

function isTerminal(status: Task['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function expired(task: Task, now: Date): boolean {
  return task.ttl !== null && Date.parse(task.lastUpdatedAt) + task.ttl <= now.getTime();
}
