import { appendFile, chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import writeFileAtomic from 'write-file-atomic';

export class DurableStore {
  readonly root: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.root = join(resolve(workspaceRoot), '.hawk', 'brain');
  }

  async writeJson<T>(collection: string, id: string, value: T): Promise<void> {
    const file = this.file(collection, id, 'json');
    await this.serialize(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        fsync: true,
      });
      await chmod(file, 0o600).catch(() => undefined);
    });
  }

  async readJson<T>(collection: string, id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file(collection, id, 'json'), 'utf8')) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listJson<T>(collection: string): Promise<T[]> {
    const directory = join(this.root, safeSegment(collection));
    try {
      const names = await readdir(directory);
      const values: T[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
        try {
          values.push(JSON.parse(await readFile(join(directory, name), 'utf8')) as T);
        } catch {
          // Ignore an incomplete or externally corrupted snapshot and keep reading the collection.
        }
      }
      return values;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async appendJsonLine(collection: string, id: string, value: unknown): Promise<void> {
    const file = this.file(collection, id, 'jsonl');
    await this.serialize(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify(value)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(file, 0o600).catch(() => undefined);
    });
  }

  async readJsonLines<T>(collection: string, id: string, limit = 1_000): Promise<T[]> {
    try {
      const lines = (await readFile(this.file(collection, id, 'jsonl'), 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean);
      const values: T[] = [];
      for (const line of lines.slice(Math.max(0, lines.length - limit))) {
        try {
          values.push(JSON.parse(line) as T);
        } catch {
          // A crash can leave one incomplete tail record. Preserve every valid
          // event instead of making the complete durable run unreadable.
        }
      }
      return values;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private file(collection: string, id: string, extension: 'json' | 'jsonl'): string {
    return join(this.root, safeSegment(collection), `${safeSegment(id)}.${extension}`);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value))
    throw new Error(`Unsafe storage key: ${value}`);
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
