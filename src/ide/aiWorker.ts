import { lstat, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent } from '../agent/agent.js';
import type { AgentEvent } from '../agent/events.js';
import * as config from '../config/config.js';
import { createRoutedClient, purposeForTask } from '../llm/routing.js';
import type { Decision, Prompter, Request } from '../permission/permission.js';
import { Store } from '../session/store.js';
import { skillSearchDirs } from '../skills/discovery.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { newTarget } from '../target/target.js';
import {
  FileEditTool,
  FileEditToolAlias,
  FileReadTool,
  FileReadToolAlias,
  FileWriteTool,
  FileWriteToolAlias,
} from '../tools/file.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { GlobTool, GrepTool } from '../tools/search.js';
import { type Tool, argString } from '../tools/types.js';

interface WorkerRequest {
  sessionId: string;
  agentSessionPath: string;
  workspaceRoot: string;
  prompt: string;
  context?: string;
}

interface WorkerEnvelope {
  type: 'agent-event' | 'worker-info' | 'worker-result';
  event?: ReturnType<typeof serializeEvent>;
  provider?: string;
  model?: string;
  ok?: boolean;
}

/**
 * Runs one native Hawk AI turn in an isolated git worktree. The daemon starts
 * this mode as a child process so relative file tools are naturally rooted in
 * the worktree and a crashed provider cannot take down the local control plane.
 */
export async function runAiWorkerCli(): Promise<void> {
  const request = await readWorkerRequest();
  const root = await realpath(resolve(request.workspaceRoot));
  const cfg = config.load();
  const client = createRoutedClient(cfg, purposeForTask(request.prompt));
  emit({ type: 'worker-info', provider: client.name(), model: client.model() });

  const prompter = new WorkspacePrompter(root);
  const tools = new ToolRegistry();
  for (const tool of [
    new FileReadTool(),
    new FileReadToolAlias(),
    new FileWriteTool(),
    new FileWriteToolAlias(),
    new FileEditTool(),
    new FileEditToolAlias(),
    new IsolatedFileDeleteTool(),
    new GlobTool(),
    new GrepTool(),
  ]) {
    tools.register(new WorkspaceBoundTool(root, tool));
  }

  const skills = new SkillRegistry();
  for (const directory of skillSearchDirs(cfg.skills_dirs)) skills.loadDir(directory);
  skills.setDisabledNames(cfg.disabled_skills);

  const store = new Store(request.agentSessionPath, request.sessionId);
  const agent = new Agent({
    client,
    tools,
    skills,
    prompter,
    store,
    target: newTarget(),
    thinkingEnabled: cfg.thinking_enabled,
    maxSteps: cfg.max_steps > 0 ? cfg.max_steps : 30,
    autoCompactThreshold: cfg.auto_compact_threshold,
    toolingProfile: cfg.tooling_profile ?? 'minimal',
    streamingEnabled: cfg.streaming_enabled,
  });
  if (agent.hasSavedSession()) agent.resumeSaved();

  let failed = false;
  const task = buildWorkerPrompt(request.prompt, request.context);
  await agent.run(task, new AbortController().signal, (event) => {
    if (event.type === 'error') failed = true;
    emit({ type: 'agent-event', event: serializeEvent(event) });
  });
  emit({ type: 'worker-result', ok: !failed });
}

class WorkspacePrompter implements Prompter {
  constructor(private readonly root: string) {}

  async ask(request: Request): Promise<Decision> {
    if (request.tool === 'file') return 'deny';
    if (
      (request.tool === 'file_write' ||
        request.tool === 'FileWriteTool' ||
        request.tool === 'file_edit' ||
        request.tool === 'FileEditTool' ||
        request.tool === 'file_delete') &&
      request.cacheKey &&
      isInside(this.root, resolve(request.cacheKey))
    ) {
      return 'allow-once';
    }
    return 'deny';
  }
}

export class IsolatedFileDeleteTool implements Tool {
  name(): string {
    return 'file_delete';
  }

  description(): string {
    return 'Delete one file from the isolated Hawk worktree. Directories cannot be deleted.';
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to delete.' },
      },
      required: ['path'],
    };
  }

  requiresPermission(): boolean {
    return true;
  }

  permissionHints(args: Record<string, unknown>): { cacheKey: string; noSessionCache: true } {
    return { cacheKey: resolve(argString(args, 'path')), noSessionCache: true };
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const path = argString(args, 'path');
    return { summary: `delete file: ${path}`, detail: `path: ${path}` };
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const path = argString(args, 'path');
    if (!path) throw new Error('path is required');
    const abs = resolve(path);
    const info = await lstat(abs);
    if (info.isDirectory()) {
      throw new Error('file_delete cannot delete directories');
    }
    await unlink(abs);
    return `deleted ${abs}`;
  }
}

class WorkspaceBoundTool implements Tool {
  constructor(
    private readonly root: string,
    private readonly inner: Tool,
  ) {}

  name(): string {
    return this.inner.name();
  }

  description(): string {
    return `${this.inner.description()} Paths are restricted to the isolated Hawk worktree.`;
  }

  schema(): Record<string, unknown> {
    return this.inner.schema();
  }

  requiresPermission(): boolean {
    return this.inner.requiresPermission();
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    return (
      this.inner.summarize?.(args) ?? {
        summary: this.inner.name(),
        detail: JSON.stringify(args),
      }
    );
  }

  permissionHints(args: Record<string, unknown>): {
    noSessionCache?: boolean;
    cacheKey?: string;
  } {
    return this.inner.permissionHints?.(args) ?? {};
  }

  async run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    prompter: Prompter,
  ): Promise<string> {
    const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const lexical = resolve(rawPath);
    if (!isInside(this.root, lexical)) {
      throw new Error(`path is outside the isolated Hawk worktree: ${rawPath}`);
    }
    const existing = await closestExistingPath(lexical);
    const canonical = await realpath(existing);
    if (!isInside(this.root, canonical)) {
      throw new Error(`path resolves outside the isolated Hawk worktree: ${rawPath}`);
    }
    const globPattern =
      this.inner.name() === 'GlobTool'
        ? args.pattern
        : this.inner.name() === 'GrepTool'
          ? args.glob
          : undefined;
    if (typeof globPattern === 'string' && unsafeGlob(globPattern)) {
      throw new Error('glob patterns may not escape the isolated Hawk worktree');
    }
    return await this.inner.run(args, signal, prompter);
  }
}

function buildWorkerPrompt(prompt: string, context = ''): string {
  return [
    'You are Hawk AI inside an isolated git worktree.',
    'Complete the requested coding or security-review task with the available workspace tools.',
    'Inspect the relevant files before editing. Make the smallest coherent implementation.',
    'You can read, write, edit, or delete files and search the isolated worktree.',
    'Do not claim tests were run: the Hawk daemon runs approved test gates after your turn.',
    'Do not access paths outside this worktree and do not access network targets.',
    'When edits are needed, perform them now; do not only describe a patch.',
    '',
    'User task:',
    prompt,
    context ? `\nWorkspace context supplied by the IDE:\n${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function serializeEvent(event: AgentEvent): {
  type: string;
  text: string;
  tool?: string;
  durationMs?: number;
} {
  switch (event.type) {
    case 'assistant-delta':
    case 'assistant-text':
      return { type: event.type, text: event.text.slice(0, 100_000) };
    case 'decision':
      return { type: 'plan', text: event.summary.slice(0, 20_000) };
    case 'tool-call':
      return {
        type: 'tool-call',
        tool: event.name,
        text: `${event.name} ${event.argsJSON}`.slice(0, 20_000),
      };
    case 'tool-result':
      return {
        type: 'tool-result',
        tool: event.name,
        durationMs: event.durationMs,
        text: (event.err || event.result).slice(0, 50_000),
      };
    case 'error':
      return { type: 'error', text: event.err.message.slice(0, 20_000) };
    case 'compact':
      return { type: 'status', text: `Context compacted: ${event.summary}`.slice(0, 20_000) };
    case 'skill-active':
      return { type: 'status', text: `Skill active: ${event.name}` };
    case 'memory-recall':
      return { type: 'status', text: `Memory recalled: ${event.names.join(', ')}` };
    case 'done':
      return { type: 'done', text: 'Agent turn completed.' };
  }
}

async function closestExistingPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = resolve(current, '..');
      if (parent === current) throw err;
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function unsafeGlob(pattern: string): boolean {
  if (isAbsolute(pattern)) return true;
  return pattern
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part === '..');
}

async function readWorkerRequest(): Promise<WorkerRequest> {
  const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Partial<WorkerRequest>;
    if (!value.sessionId || !value.agentSessionPath || !value.workspaceRoot || !value.prompt) {
      throw new Error('AI worker request is missing required fields');
    }
    return value as WorkerRequest;
  }
  throw new Error('AI worker did not receive a request');
}

function emit(envelope: WorkerEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
