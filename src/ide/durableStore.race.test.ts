import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableStore concurrency and recovery', () => {
  it('serializes concurrent writes and keeps the final complete JSON snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-durable-race-'));
    roots.push(root);
    const store = new DurableStore(root);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.writeJson('runs', 'same-run', { index, payload: 'x'.repeat(64) }),
      ),
    );
    await expect(store.readJson<{ index: number }>('runs', 'same-run')).resolves.toEqual({
      index: 99,
      payload: 'x'.repeat(64),
    });
  });

  it('keeps every concurrent JSONL event exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-durable-events-'));
    roots.push(root);
    const store = new DurableStore(root);
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        store.appendJsonLine('run-events', 'run-1', { index }),
      ),
    );
    const events = await store.readJsonLines<{ index: number }>('run-events', 'run-1', 200);
    expect(events).toHaveLength(120);
    expect(events.map((event) => event.index)).toEqual(Array.from({ length: 120 }, (_, i) => i));
  });

  it('recovers valid events around a crash-truncated JSONL line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-durable-truncated-'));
    roots.push(root);
    const store = new DurableStore(root);
    await store.appendJsonLine('run-events', 'run-1', { index: 1 });
    await appendFile(
      join(root, '.hawk', 'brain', 'run-events', 'run-1.jsonl'),
      '{"index":2\n',
      'utf8',
    );
    await store.appendJsonLine('run-events', 'run-1', { index: 3 });
    await expect(store.readJsonLines('run-events', 'run-1')).resolves.toEqual([
      { index: 1 },
      { index: 3 },
    ]);
  });
});
