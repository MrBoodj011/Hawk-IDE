import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  it('migrates a legacy session in place and preserves review state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-migration-'));
    temporaryRoots.push(root);
    const storageRoot = join(root, '.test-storage');
    const sessionsRoot = join(storageRoot, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const id = '8d927176-f2f3-4bd3-ae31-e5347a1484e8';
    const now = '2026-07-20T12:00:00.000Z';
    await writeFile(
      join(sessionsRoot, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Legacy review',
        prompt: 'Review the legacy patch',
        status: 'awaiting-review',
        createdAt: now,
        updatedAt: now,
        workspaceRoot: root,
        repoRoot: root,
        workspaceRelative: '',
        worktreeRoot: join(root, 'worktree'),
        workerRoot: join(root, 'worktree'),
        snapshotCommit: 'deadbeef',
        patchPath: join(storageRoot, 'patches', `${id}.patch`),
        agentSessionPath: join(storageRoot, 'agent', `${id}.json`),
      }),
      'utf8',
    );
    const manager = new AiSessionManager({ workspaceRoot: root, storageRoot });
    await manager.initialize();
    try {
      await expect(manager.get(id)).resolves.toMatchObject({
        id,
        status: 'awaiting-review',
        background: false,
        autoResume: false,
        resumeCount: 0,
        checkpoints: [],
        testGates: [],
        testResults: [],
      });
      const migrated = JSON.parse(await readFile(join(sessionsRoot, `${id}.json`), 'utf8')) as {
        version?: number;
        status?: string;
      };
      expect(migrated).toMatchObject({ version: 1, status: 'awaiting-review' });
    } finally {
      await manager.dispose();
    }
  });

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
  }, 45_000);

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
  }, 45_000);

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

  it('pauses and resumes an isolated background task without losing its worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-resume-'));
    temporaryRoots.push(root);
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Test']);
    await git(root, ['config', 'user.email', 'hawk-test@localhost']);
    await writeFile(join(root, 'app.txt'), 'base\n', 'utf8');
    await git(root, ['add', 'app.txt']);
    await git(root, ['commit', '-m', 'base']);
    const worker = join(root, 'resume-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', () => {",
        "  if (!fs.existsSync('.resume-marker')) {",
        "    fs.writeFileSync('.resume-marker', 'ready');",
        '    setInterval(() => {}, 1000);',
        '    return;',
        '  }',
        "  fs.appendFileSync('app.txt', 'resumed\\n');",
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
      const created = await manager.create({
        prompt: 'Complete the background edit',
        background: true,
        autoResume: true,
      });
      expect(created.background).toBe(true);
      const marker = join(created.sandboxPath ?? '', '.resume-marker');
      const markerDeadline = Date.now() + 5_000;
      while (
        !(await stat(marker)
          .then(() => true)
          .catch(() => false))
      ) {
        if (Date.now() > markerDeadline) throw new Error('worker did not create resume marker');
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      const paused = await manager.pause(created.id);
      expect(paused.status).toBe('paused');
      expect(paused.canResume).toBe(true);
      const resumed = await manager.resume(created.id);
      expect(resumed.status).toBe('running');
      expect(resumed.resumeCount).toBe(1);
      const review = await waitForStatus(manager, created.id, 'awaiting-review');
      expect(review.diff).toBeDefined();
      expect(review.canApply).toBe(true);
      await manager.reject(created.id);
    } finally {
      await manager.dispose();
    }
  }, 15_000);

  it('seeds a merge worktree with compatible AST changes before model conflict resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ai-semantic-merge-'));
    temporaryRoots.push(root);
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Hawk Test']);
    await git(root, ['config', 'user.email', 'hawk-test@localhost']);
    await writeFile(
      join(root, 'policy.ts'),
      [
        'export class Policy {',
        '  authorize(role: string): boolean {',
        "    return role === 'admin';",
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await git(root, ['add', 'policy.ts']);
    await git(root, ['commit', '-m', 'base']);
    const worker = join(root, 'semantic-worker.cjs');
    await writeFile(
      worker,
      [
        "const fs = require('node:fs');",
        'process.stdin.resume();',
        "process.stdin.once('data', (chunk) => {",
        '  const request = JSON.parse(chunk.toString());',
        "  const path = 'policy.ts';",
        '  let source = fs.readFileSync(path, "utf8");',
        "  if (request.prompt.includes('owner lane')) {",
        "    source = source.replace(\"role === 'admin'\", \"role === 'admin' || role === 'owner'\");",
        '    fs.writeFileSync(path, source);',
        "  } else if (request.prompt.includes('audit lane')) {",
        "    source = source.replace(/\\r?\\n}\\r?\\n/, '\\n\\n  audit(role: string): string {\\n    return `checked:${role}`;\\n  }\\n}\\n');",
        '    fs.writeFileSync(path, source);',
        '  }',
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
      const owner = await manager.create({ prompt: 'owner lane change' });
      const audit = await manager.create({ prompt: 'audit lane change' });
      await waitForStatus(manager, owner.id, 'awaiting-review');
      await waitForStatus(manager, audit.id, 'awaiting-review');

      const merged = await manager.mergeBatch({
        sessionIds: [owner.id, audit.id],
        objective: 'combine policy behavior',
      });
      const review = await waitForStatus(manager, merged.mergeSession.id, 'awaiting-review');
      const seeded = normalizeLines(
        await readFile(join(review.sandboxPath ?? '', 'policy.ts'), 'utf8'),
      );

      expect(seeded).toContain("role === 'admin' || role === 'owner'");
      expect(seeded).toContain('audit(role: string)');
      expect(merged.semanticMerge.conflicts).toEqual([]);
      expect(merged.semanticMerge.automaticallyMergedUnits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ strategy: 'ast-add', candidateId: audit.id }),
        ]),
      );
      await manager.reject(merged.mergeSession.id);
      await manager.reject(owner.id);
      await manager.reject(audit.id);
    } finally {
      await manager.dispose();
    }
  }, 60_000);
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
