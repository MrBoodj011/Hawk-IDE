import { lstat, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentEvent } from '../agent/events.js';
import type { Decision, Prompter, Request } from '../permission/permission.js';
import { type Tool, argString } from '../tools/types.js';

/**
 * Permission and filesystem boundary shared by every isolated AI worker tool.
 * Keeping this policy separate from worker bootstrapping makes the boundary
 * directly testable without starting a model process.
 */
export class WorkspacePrompter implements Prompter {
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
      isInsideWorkspace(this.root, resolve(request.cacheKey))
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

export class WorkspaceBoundTool implements Tool {
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
    if (!isInsideWorkspace(this.root, lexical)) {
      throw new Error(`path is outside the isolated Hawk worktree: ${rawPath}`);
    }
    const existing = await closestExistingPath(lexical);
    const [canonicalRoot, canonical] = await Promise.all([realpath(this.root), realpath(existing)]);
    if (!isInsideWorkspace(canonicalRoot, canonical)) {
      throw new Error(`path resolves outside the isolated Hawk worktree: ${rawPath}`);
    }
    const globPattern =
      this.inner.name() === 'GlobTool'
        ? args.pattern
        : this.inner.name() === 'GrepTool'
          ? args.glob
          : undefined;
    if (typeof globPattern === 'string' && unsafeWorkspaceGlob(globPattern)) {
      throw new Error('glob patterns may not escape the isolated Hawk worktree');
    }
    return await this.inner.run(args, signal, prompter);
  }
}

export function buildWorkerPrompt(prompt: string, context = ''): string {
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

export function serializeWorkerEvent(event: AgentEvent): {
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

export function isInsideWorkspace(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function unsafeWorkspaceGlob(pattern: string): boolean {
  if (isAbsolute(pattern)) return true;
  return pattern
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part === '..');
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
