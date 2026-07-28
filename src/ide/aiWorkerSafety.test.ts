import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlwaysAllow } from '../permission/permission.js';
import type { Tool } from '../tools/types.js';
import {
  IsolatedFileDeleteTool,
  WorkspaceBoundTool,
  WorkspacePrompter,
  buildWorkerPrompt,
  isInsideWorkspace,
  serializeWorkerEvent,
  unsafeWorkspaceGlob,
} from './aiWorkerSafety.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('isolated AI worker safety boundary', () => {
  it('allows scoped edits while denying reads and paths outside the worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-worker-policy-'));
    roots.push(root);
    const prompter = new WorkspacePrompter(root);

    await expect(
      prompter.ask({ tool: 'file', summary: 'read', detail: '', cacheKey: join(root, 'a.ts') }),
    ).resolves.toBe('deny');
    await expect(
      prompter.ask({
        tool: 'file_write',
        summary: 'write',
        detail: '',
        cacheKey: join(root, 'a.ts'),
      }),
    ).resolves.toBe('allow-once');
    await expect(
      prompter.ask({
        tool: 'file_write',
        summary: 'escape',
        detail: '',
        cacheKey: resolve(root, '..', 'outside.ts'),
      }),
    ).resolves.toBe('deny');
    expect(isInsideWorkspace(root, root)).toBe(true);
    expect(isInsideWorkspace(root, resolve(root, '..'))).toBe(false);
  });

  it('rejects traversal globs and prevents wrapped tools from escaping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-worker-bound-'));
    roots.push(root);
    const run = vi.fn(async () => 'ok');
    const inner: Tool = {
      name: () => 'GlobTool',
      description: () => 'glob',
      schema: () => ({}),
      requiresPermission: () => false,
      run,
    };
    const tool = new WorkspaceBoundTool(root, inner);
    const signal = new AbortController().signal;

    expect(unsafeWorkspaceGlob('../**/*')).toBe(true);
    expect(unsafeWorkspaceGlob('src/**/*.ts')).toBe(false);
    await expect(
      tool.run({ path: root, pattern: '../**/*' }, signal, new AlwaysAllow()),
    ).rejects.toThrow(/glob patterns/);
    await expect(
      tool.run({ path: resolve(root, '..') }, signal, new AlwaysAllow()),
    ).rejects.toThrow(/outside/);
    await expect(
      tool.run({ path: root, pattern: 'src/**/*.ts' }, signal, new AlwaysAllow()),
    ).resolves.toBe('ok');
    expect(run).toHaveBeenCalledOnce();
  });

  it('deletes files but refuses directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-worker-delete-'));
    roots.push(root);
    const file = join(root, 'candidate.txt');
    const directory = join(root, 'folder');
    await writeFile(file, 'candidate');
    await mkdir(directory);
    const tool = new IsolatedFileDeleteTool();

    await expect(tool.run({ path: directory })).rejects.toThrow(/cannot delete directories/);
    await expect(tool.run({ path: file })).resolves.toContain('deleted');
    await expect(access(file)).rejects.toThrow();
  });

  it('builds bounded model context and serializes worker events safely', () => {
    const prompt = buildWorkerPrompt('Fix auth', 'src/auth.ts is open');
    expect(prompt).toContain('isolated git worktree');
    expect(prompt).toContain('Fix auth');
    expect(prompt).toContain('src/auth.ts is open');
    expect(
      serializeWorkerEvent({
        type: 'tool-result',
        id: 'tool-1',
        name: 'file_edit',
        result: 'changed',
        err: '',
        durationMs: 12,
      }),
    ).toEqual({
      type: 'tool-result',
      tool: 'file_edit',
      durationMs: 12,
      text: 'changed',
    });
    expect(serializeWorkerEvent({ type: 'done' })).toEqual({
      type: 'done',
      text: 'Agent turn completed.',
    });
  });
});
