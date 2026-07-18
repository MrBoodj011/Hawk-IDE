import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AiSessionManager } from './aiSessionManager.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('AiSessionManager', () => {
  it('isolates an agent edit, exposes its exact diff, applies it, and reverts safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-session-'));
    temporaryRoots.push(root);
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Test']);
    await git(root, ['config', 'user.email', 'hawk-test@localhost']);
    await writeFile(join(root, 'app.txt'), 'base\n', 'utf8');
    await git(root, ['add', 'app.txt']);
    await git(root, ['commit', '-m', 'base']);

    const worker = join(root, 'fake-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', () => {",
        "  fs.appendFileSync('app.txt', 'hawk\\n');",
        "  console.log(JSON.stringify({ type: 'worker-info', provider: 'test', model: 'fake' }));",
        "  console.log(JSON.stringify({ type: 'agent-event', event: { type: 'assistant-delta', text: 'patched' } }));",
        "  console.log(JSON.stringify({ type: 'worker-result', ok: true }));",
        '});',
      ].join('\n'),
      'utf8',
    );

    const manager = new AiSessionManager({
      workspaceRoot: root,
      storageRoot: join(root, '.test-storage'),
      workerLaunch: { command: process.execPath, args: [worker] },
    });
    await manager.initialize();
    try {
      const created = await manager.create({ prompt: 'Patch app.txt' });
      const review = await waitForStatus(manager, created.id, 'awaiting-review');
      expect(review.provider).toBe('test');
      expect(review.diff).toMatchObject({ files: 1, insertions: 1, deletions: 0 });
      expect(normalizeLines(await readFile(join(root, 'app.txt'), 'utf8'))).toBe('base\n');

      const diff = await manager.diff(created.id);
      expect(diff.patch).toContain('+hawk');
      const checkpointed = await manager.checkpoint(created.id, { label: 'working patch' });
      expect(checkpointed.checkpoints).toEqual([
        expect.objectContaining({ label: 'working patch', patchHash: diff.summary.patchHash }),
      ]);
      expect(checkpointed.canOpenTerminal).toBe(true);
      await writeFile(join(checkpointed.sandboxPath ?? '', 'app.txt'), 'discard me\n', 'utf8');
      const restored = await manager.restoreCheckpoint(created.id, {
        approved: true,
        checkpointId: checkpointed.checkpoints[0]?.id ?? '',
      });
      expect(restored.diff?.patchHash).toBe(diff.summary.patchHash);
      expect((await manager.diff(created.id)).patch).toContain('+hawk');
      const events = await manager.events(created.id);
      expect(events.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'assistant-delta', text: 'patched' }),
          expect.objectContaining({ type: 'diff-ready' }),
        ]),
      );

      const applied = await manager.apply(created.id, {
        approved: true,
        patchHash: diff.summary.patchHash,
      });
      expect(applied.status).toBe('applied');
      expect(normalizeLines(await readFile(join(root, 'app.txt'), 'utf8'))).toBe('base\nhawk\n');

      const reverted = await manager.revert(created.id);
      expect(reverted.status).toBe('reverted');
      expect(normalizeLines(await readFile(join(root, 'app.txt'), 'utf8'))).toBe('base\n');
    } finally {
      await manager.dispose();
    }
  }, 15_000);

  it('refuses apply when the reviewed hash is stale or a touched workspace file drifted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-drift-'));
    temporaryRoots.push(root);
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Test']);
    await git(root, ['config', 'user.email', 'hawk-test@localhost']);
    await writeFile(join(root, 'app.txt'), 'base\n', 'utf8');
    await git(root, ['add', 'app.txt']);
    await git(root, ['commit', '-m', 'base']);
    const worker = join(root, 'fake-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', () => {",
        "  fs.appendFileSync('app.txt', 'hawk\\n');",
        "  console.log(JSON.stringify({ type: 'worker-result', ok: true }));",
        '});',
      ].join('\n'),
      'utf8',
    );
    const manager = new AiSessionManager({
      workspaceRoot: root,
      storageRoot: join(root, '.test-storage'),
      workerLaunch: { command: process.execPath, args: [worker] },
    });
    await manager.initialize();
    try {
      const created = await manager.create({ prompt: 'Patch app.txt' });
      const review = await waitForStatus(manager, created.id, 'awaiting-review');
      await expect(
        manager.apply(created.id, {
          approved: true,
          patchHash: `stale-${review.diff?.patchHash ?? ''}`,
        }),
      ).rejects.toThrow('reviewed diff changed');

      await writeFile(join(root, 'app.txt'), 'operator edit\n', 'utf8');
      await expect(
        manager.apply(created.id, {
          approved: true,
          patchHash: review.diff?.patchHash ?? '',
        }),
      ).rejects.toThrow('changed after this Hawk session started');
      expect(await readFile(join(root, 'app.txt'), 'utf8')).toBe('operator edit\n');
      await manager.reject(created.id);
    } finally {
      await manager.dispose();
    }
  }, 15_000);

  it('requires every detected test gate to pass unless the operator explicitly overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-gates-'));
    temporaryRoots.push(root);
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Test']);
    await git(root, ['config', 'user.email', 'hawk-test@localhost']);
    await writeFile(join(root, 'app.txt'), 'base\n', 'utf8');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
        },
      }),
      'utf8',
    );
    await git(root, ['add', 'app.txt', 'package.json']);
    await git(root, ['commit', '-m', 'base']);

    const worker = join(root, 'fake-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', () => {",
        "  fs.appendFileSync('app.txt', 'hawk\\n');",
        "  console.log(JSON.stringify({ type: 'worker-result', ok: true }));",
        '});',
      ].join('\n'),
      'utf8',
    );

    const manager = new AiSessionManager({
      workspaceRoot: root,
      storageRoot: join(root, '.test-storage'),
      workerLaunch: { command: process.execPath, args: [worker] },
    });
    await manager.initialize();
    try {
      const created = await manager.create({ prompt: 'Patch app.txt' });
      const review = await waitForStatus(manager, created.id, 'awaiting-review');
      expect(review.testGates.map((gate) => gate.id)).toEqual(['npm:typecheck', 'npm:lint']);

      const tested = await manager.runTests(created.id, {
        approved: true,
        gateIds: ['npm:typecheck'],
      });
      expect(tested.testResults).toEqual([
        expect.objectContaining({ gateId: 'npm:typecheck', status: 'passed' }),
      ]);

      await expect(
        manager.apply(created.id, {
          approved: true,
          patchHash: review.diff?.patchHash ?? '',
        }),
      ).rejects.toThrow('test gates have not passed');

      const applied = await manager.apply(created.id, {
        approved: true,
        patchHash: review.diff?.patchHash ?? '',
        allowFailingTests: true,
      });
      expect(applied.status).toBe('applied');
    } finally {
      await manager.dispose();
    }
  }, 15_000);
});

async function waitForStatus(
  manager: AiSessionManager,
  id: string,
  status: 'awaiting-review',
): Promise<Awaited<ReturnType<AiSessionManager['get']>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const session = await manager.get(id);
    if (session.status === status) return session;
    if (session.status === 'failed') throw new Error(session.error ?? 'AI session failed');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`timed out waiting for ${status}`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

function normalizeLines(value: string): string {
  return value.replaceAll('\r\n', '\n');
}
