import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { migrateSemanticIndexDocument } from './stateMigrations.js';

// Bump this whenever the on-disk representation changes. Version 5 stores
// embeddings in compact Float32/base64 form and derives `normalized` text on
// load, and records per-file representative-chunk truncation.
const INDEX_VERSION = 5;
const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 2_500_000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_PERSISTED_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_CHUNKS = 2_100;
const MAX_CHUNKS_PER_FILE = 24;
// The resident index is deliberately below the process-level 500 MiB gate so
// the daemon still has room for the TypeScript parser, HTTP server, and LLM
// request buffers while a rebuild is in progress.
const MAX_RESIDENT_INDEX_BYTES = 320 * 1024 * 1024;
const MAX_INDEX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_TERMS_PER_CHUNK = 128;
const MAX_FACTS_PER_FILE = 4_000;
const MAX_AST_FILE_BYTES = 512 * 1024;
const CHUNK_LINES = 96;
const CHUNK_OVERLAP = 16;
const MAX_RESULT_LIMIT = 30;
const EMBEDDING_BATCH_SIZE = 24;
const MAX_EMBEDDING_CHARS = 3_000;
const MAX_EMBEDDING_DIMENSIONS = 1_024;
const EMBEDDING_TIMEOUT_MS = 45_000;

const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.md',
  '.mjs',
  '.mts',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hawk',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

export interface SemanticEmbeddingOptions {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
}

export interface SemanticIndexOptions {
  storageRoot?: string;
  embeddings?: SemanticEmbeddingOptions;
}

export interface SemanticIndexStats {
  indexedAt: string;
  files: number;
  chunks: number;
  symbols: number;
  types: number;
  imports: number;
  calls: number;
  bytes: number;
  durationMs: number;
  truncated: boolean;
  reusedFiles: number;
  changedFiles: number;
  persistent: boolean;
  memory: {
    /** Conservative estimate of the resident index data (not process RSS). */
    residentBytes: number;
    /** Hard resident-index ceiling; the process gate remains 500 MiB RSS. */
    budgetBytes: number;
  };
  embedding: {
    enabled: boolean;
    model?: string;
    chunks: number;
    dimensions: number;
    status: 'disabled' | 'ready' | 'unavailable';
    error?: string;
  };
}

export interface SemanticSearchResult {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  symbols: string[];
  types: string[];
  imports: string[];
  preview: string;
  match: 'lexical' | 'hybrid';
}

interface StructuralFact {
  line: number;
  kind: 'symbol' | 'type' | 'import' | 'call';
  name: string;
  detail: string;
}

interface IndexedChunk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  normalized: string;
  terms: Map<string, number>;
  symbols: string[];
  types: string[];
  imports: string[];
  calls: string[];
  structural: string;
  embedding?: number[];
}

interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  bytes: number;
  truncated: boolean;
  chunks: IndexedChunk[];
}

interface StoredChunk extends Omit<IndexedChunk, 'terms' | 'normalized' | 'embedding'> {
  terms: Array<[string, number]>;
  /** Float32 embedding bytes encoded as base64 to avoid JSON number bloat. */
  embedding?: string;
}

interface StoredFile extends Omit<IndexedFile, 'chunks'> {
  chunks: StoredChunk[];
}

interface StoredIndex {
  version: number;
  rootHash: string;
  files: StoredFile[];
  stats: SemanticIndexStats;
}

/**
 * Persistent, incremental workspace intelligence for Hawk.
 *
 * TypeScript and JavaScript are parsed with the TypeScript AST so declarations,
 * type annotations, imports and calls become first-class ranking signals.
 * Other supported languages use bounded structural parsers. Source never
 * leaves the machine; optional vector ranking talks only to a loopback Ollama.
 */
export class SemanticWorkspaceIndex {
  private readonly root: string;
  private readonly storageRoot: string;
  private readonly indexPath: string;
  private readonly rootHash: string;
  private readonly embeddings: Required<SemanticEmbeddingOptions>;
  private chunks: IndexedChunk[] = [];
  private files = new Map<string, IndexedFile>();
  private documentFrequency = new Map<string, number>();
  private currentStats: SemanticIndexStats | undefined;
  private building: Promise<SemanticIndexStats> | undefined;
  private loaded = false;

  constructor(workspaceRoot: string, options: SemanticIndexOptions = {}) {
    this.root = resolve(workspaceRoot);
    this.rootHash = createHash('sha256').update(this.root.toLowerCase()).digest('hex').slice(0, 24);
    this.storageRoot =
      options.storageRoot ?? join(homedir(), '.hawk', 'ide', 'indexes', this.rootHash);
    this.indexPath = join(this.storageRoot, 'semantic-index-v2.json');
    this.embeddings = {
      enabled: options.embeddings?.enabled === true,
      baseUrl: normalizeLoopbackBaseUrl(options.embeddings?.baseUrl),
      model: options.embeddings?.model?.trim() || 'embeddinggemma',
    };
  }

  stats(): SemanticIndexStats | undefined {
    return this.currentStats;
  }

  async ensureBuilt(): Promise<SemanticIndexStats> {
    if (!this.loaded) await this.loadPersistentIndex();
    return this.currentStats ?? (await this.build());
  }

  async build(): Promise<SemanticIndexStats> {
    if (this.building) return await this.building;
    this.building = this.buildNow();
    try {
      return await this.building;
    } finally {
      this.building = undefined;
    }
  }

  search(query: string, limit = 8): SemanticSearchResult[] {
    return this.rank(query, limit);
  }

  async searchHybrid(query: string, limit = 8): Promise<SemanticSearchResult[]> {
    await this.ensureBuilt();
    if (!this.embeddings.enabled) return this.rank(query, limit);
    try {
      const [queryEmbedding] = await requestEmbeddings(
        this.embeddings.baseUrl,
        this.embeddings.model,
        [query.slice(0, MAX_EMBEDDING_CHARS)],
      );
      if (!queryEmbedding?.length) return this.rank(query, limit);
      return this.rank(query, limit, queryEmbedding);
    } catch {
      return this.rank(query, limit);
    }
  }

  async updateFile(filePath: string): Promise<SemanticIndexStats> {
    await this.ensureBuilt();
    const absolutePath = resolve(this.root, filePath);
    assertInside(this.root, absolutePath);
    const file = relative(this.root, absolutePath).replaceAll('\\', '/');
    const info = await stat(absolutePath).catch(() => undefined);
    if (
      !info?.isFile() ||
      !SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) ||
      info.size > MAX_FILE_BYTES
    ) {
      return await this.removeFile(file);
    }
    const indexed = await this.indexOneFile(absolutePath, file, info.size, info.mtimeMs);
    if (!indexed) return await this.removeFile(file);
    const previous = this.files.get(file);
    const currentBytes = [...this.files.values()].reduce((total, item) => total + item.bytes, 0);
    const currentChunks = [...this.files.values()].reduce(
      (total, item) => total + item.chunks.length,
      0,
    );
    const projectedFiles = this.files.size + (previous ? 0 : 1);
    const projectedBytes = currentBytes - (previous?.bytes ?? 0) + indexed.bytes;
    const projectedChunks = currentChunks - (previous?.chunks.length ?? 0) + indexed.chunks.length;
    if (
      projectedFiles > MAX_FILES ||
      projectedBytes > MAX_TOTAL_BYTES ||
      projectedChunks > MAX_CHUNKS
    ) {
      // Never keep stale facts for a file that changed after the bounded index
      // reached capacity. The next full rebuild can admit it by source priority.
      this.files.delete(file);
      return await this.commitStats({
        startedAt: Date.now(),
        truncated: true,
        reusedFiles: this.files.size,
        changedFiles: previous ? 1 : 0,
      });
    }
    await this.embedChangedChunks(indexed.chunks);
    this.files.set(file, indexed);
    this.enforceResidentBudget();
    if (this.estimateResidentBytes() > MAX_RESIDENT_INDEX_BYTES) {
      this.files.delete(file);
      return await this.commitStats({
        startedAt: Date.now(),
        truncated: true,
        reusedFiles: Math.max(0, this.files.size - 1),
        changedFiles: 1,
      });
    }
    return await this.commitStats({
      startedAt: Date.now(),
      truncated: indexed.truncated,
      reusedFiles: Math.max(0, this.files.size - 1),
      changedFiles: 1,
    });
  }

  async removeFile(filePath: string): Promise<SemanticIndexStats> {
    await this.ensureBuilt();
    const normalized = filePath.replaceAll('\\', '/');
    this.files.delete(normalized);
    return await this.commitStats({
      startedAt: Date.now(),
      truncated: false,
      reusedFiles: this.files.size,
      changedFiles: 1,
    });
  }

  private async buildNow(): Promise<SemanticIndexStats> {
    const startedAt = Date.now();
    await this.loadPersistentIndex();
    const discovered = await collectSourceFiles(this.root);
    // Keep the previous map only as a lookup table while rebuilding. Removing
    // entries as they are consumed releases old chunk strings early instead of
    // retaining a full old + new resident index until the final swap.
    const previousFiles = this.files;
    const nextFiles = new Map<string, IndexedFile>();
    const changedChunks: IndexedChunk[] = [];
    let bytes = 0;
    let reusedFiles = 0;
    let changedFiles = 0;
    let chunkCount = 0;
    let residentBytes = 0;
    let truncated = discovered.truncated;

    for (const absolutePath of discovered.paths) {
      const info = await stat(absolutePath).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
      if (bytes + info.size > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      if (chunkCount >= MAX_CHUNKS) {
        truncated = true;
        break;
      }
      // Windows temp/workspace roots can be junctions whose real path uses a
      // different lexical prefix (for example a short 8.3 user directory).
      // Relativize against the same canonical root used during discovery so a
      // valid workspace file never becomes ../../outside-looking metadata.
      const file = relative(discovered.root, absolutePath).replaceAll('\\', '/');
      const previous = previousFiles.get(file);
      if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
        if (previous.truncated) truncated = true;
        const previousResidentBytes = estimateIndexedFileBytes(previous);
        if (residentBytes + previousResidentBytes > MAX_RESIDENT_INDEX_BYTES) {
          truncated = true;
          break;
        }
        nextFiles.set(file, previous);
        previousFiles.delete(file);
        bytes += previous.bytes;
        chunkCount += previous.chunks.length;
        residentBytes += previousResidentBytes;
        reusedFiles += 1;
        continue;
      }
      const indexed = await this.indexOneFile(absolutePath, file, info.size, info.mtimeMs);
      previousFiles.delete(file);
      if (!indexed) continue;
      if (indexed.truncated) truncated = true;
      if (chunkCount + indexed.chunks.length > MAX_CHUNKS) {
        truncated = true;
        break;
      }
      const indexedResidentBytes = estimateIndexedFileBytes(indexed);
      if (residentBytes + indexedResidentBytes > MAX_RESIDENT_INDEX_BYTES) {
        truncated = true;
        break;
      }
      nextFiles.set(file, indexed);
      changedChunks.push(...indexed.chunks);
      bytes += indexed.bytes;
      chunkCount += indexed.chunks.length;
      residentBytes += indexedResidentBytes;
      changedFiles += 1;
    }
    changedFiles += previousFiles.size;
    previousFiles.clear();
    this.files = nextFiles;
    await this.embedChangedChunks(changedChunks);
    this.enforceResidentBudget();
    return await this.commitStats({
      startedAt,
      truncated,
      reusedFiles,
      changedFiles,
      persist: changedFiles > 0,
    });
  }

  private async indexOneFile(
    absolutePath: string,
    file: string,
    size: number,
    mtimeMs: number,
  ): Promise<IndexedFile | undefined> {
    const content = await readFile(absolutePath, 'utf8').catch(() => '');
    if (!content || content.includes('\u0000')) return undefined;
    const chunked = chunkFile(file, content);
    return {
      path: file,
      size,
      mtimeMs,
      hash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      truncated: chunked.truncated,
      chunks: chunked.chunks,
    };
  }

  private async embedChangedChunks(chunks: IndexedChunk[]): Promise<void> {
    if (!this.embeddings.enabled || chunks.length === 0) return;
    for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      try {
        const vectors = await requestEmbeddings(
          this.embeddings.baseUrl,
          this.embeddings.model,
          batch.map((chunk) =>
            `${chunk.file}\n${chunk.structural}\n${chunk.content}`.slice(0, MAX_EMBEDDING_CHARS),
          ),
        );
        for (const [index, vector] of vectors.entries()) {
          if (vector?.length && batch[index]) batch[index].embedding = vector;
        }
      } catch {
        // Optional embeddings must never make the local index unavailable.
        return;
      }
    }
  }

  private async commitStats(input: {
    startedAt: number;
    truncated: boolean;
    reusedFiles: number;
    changedFiles: number;
    persist?: boolean;
  }): Promise<SemanticIndexStats> {
    this.chunks = [...this.files.values()].flatMap((file) => file.chunks);
    this.documentFrequency = buildDocumentFrequency(this.chunks);
    const embeddingChunks = this.chunks.filter((chunk) => chunk.embedding?.length);
    const dimensions = embeddingChunks[0]?.embedding?.length ?? 0;
    const counters = this.chunks.reduce(
      (total, chunk) => ({
        symbols: total.symbols + chunk.symbols.length,
        types: total.types + chunk.types.length,
        imports: total.imports + chunk.imports.length,
        calls: total.calls + chunk.calls.length,
      }),
      { symbols: 0, types: 0, imports: 0, calls: 0 },
    );
    this.currentStats = {
      indexedAt: new Date().toISOString(),
      files: this.files.size,
      chunks: this.chunks.length,
      ...counters,
      bytes: [...this.files.values()].reduce((total, file) => total + file.bytes, 0),
      durationMs: Date.now() - input.startedAt,
      truncated: input.truncated,
      reusedFiles: input.reusedFiles,
      changedFiles: input.changedFiles,
      persistent: true,
      memory: {
        residentBytes: this.estimateResidentBytes(),
        budgetBytes: MAX_RESIDENT_INDEX_BYTES,
      },
      embedding: {
        enabled: this.embeddings.enabled,
        ...(this.embeddings.enabled ? { model: this.embeddings.model } : {}),
        chunks: embeddingChunks.length,
        dimensions,
        status: !this.embeddings.enabled
          ? 'disabled'
          : embeddingChunks.length === this.chunks.length && this.chunks.length > 0
            ? 'ready'
            : 'unavailable',
        ...(this.embeddings.enabled && embeddingChunks.length !== this.chunks.length
          ? { error: 'Ollama embedding model is unavailable; AST/lexical search remains active.' }
          : {}),
      },
    };
    if (input.persist !== false) {
      this.currentStats.persistent = await this.persist();
    }
    return this.currentStats;
  }

  private rank(query: string, limit: number, queryEmbedding?: number[]): SemanticSearchResult[] {
    const cleanQuery = query.trim().slice(0, 1_000);
    if (!cleanQuery || this.chunks.length === 0) return [];
    const queryTerms = tokenize(cleanQuery);
    if (queryTerms.length === 0 && !queryEmbedding) return [];
    const phrase = normalizeText(cleanQuery);
    const cappedLimit = Math.max(1, Math.min(MAX_RESULT_LIMIT, limit));
    return this.chunks
      .map((chunk) => {
        const lexical = scoreChunk(
          chunk,
          queryTerms,
          phrase,
          this.documentFrequency,
          this.chunks.length,
        );
        const vector =
          queryEmbedding && chunk.embedding?.length === queryEmbedding.length
            ? Math.max(0, cosineSimilarity(queryEmbedding, chunk.embedding))
            : 0;
        return {
          chunk,
          score: queryEmbedding ? lexical * 0.72 + vector * 9 * 0.28 : lexical,
          hybrid: vector > 0,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.file.localeCompare(right.chunk.file) ||
          left.chunk.startLine - right.chunk.startLine,
      )
      .slice(0, cappedLimit)
      .map(({ chunk, score, hybrid }) => ({
        id: chunk.id,
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: Number(score.toFixed(4)),
        symbols: chunk.symbols.slice(0, 16),
        types: chunk.types.slice(0, 12),
        imports: chunk.imports.slice(0, 12),
        preview: chunk.content.slice(0, 4_000),
        match: hybrid ? 'hybrid' : 'lexical',
      }));
  }

  private async loadPersistentIndex(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const info = await stat(this.indexPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_PERSISTED_INDEX_BYTES) return;
      const migration = migrateSemanticIndexDocument(
        JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown,
      );
      const stored = migration.value as unknown as StoredIndex;
      if (
        stored.version !== INDEX_VERSION ||
        stored.rootHash !== this.rootHash ||
        !Array.isArray(stored.files) ||
        stored.files.length > MAX_FILES
      ) {
        return;
      }
      let storedChunks = 0;
      let storedBytes = 0;
      let storedContentBytes = 0;
      for (const file of stored.files) {
        if (
          typeof file.path !== 'string' ||
          typeof file.hash !== 'string' ||
          !Number.isFinite(file.bytes) ||
          file.bytes < 0 ||
          !Array.isArray(file.chunks)
        ) {
          return;
        }
        assertInside(this.root, resolve(this.root, file.path));
        storedChunks += file.chunks.length;
        storedBytes += file.bytes;
        if (storedChunks > MAX_CHUNKS || storedBytes > MAX_TOTAL_BYTES) return;
        for (const chunk of file.chunks) {
          if (
            typeof chunk.id !== 'string' ||
            typeof chunk.file !== 'string' ||
            !Number.isFinite(chunk.startLine) ||
            !Number.isFinite(chunk.endLine) ||
            typeof chunk.content !== 'string' ||
            chunk.content.length > MAX_FILE_BYTES ||
            typeof chunk.structural !== 'string' ||
            !Array.isArray(chunk.terms) ||
            chunk.terms.length > MAX_TERMS_PER_CHUNK ||
            !chunk.terms.every(
              (term) =>
                Array.isArray(term) &&
                term.length === 2 &&
                typeof term[0] === 'string' &&
                Number.isFinite(term[1]),
            ) ||
            !isBoundedStringArray(chunk.symbols) ||
            !isBoundedStringArray(chunk.types) ||
            !isBoundedStringArray(chunk.imports) ||
            !isBoundedStringArray(chunk.calls)
          ) {
            return;
          }
          storedContentBytes += Buffer.byteLength(chunk.content);
          if (storedContentBytes > MAX_INDEX_CONTENT_BYTES) return;
          if (chunk.embedding !== undefined && !decodeEmbedding(chunk.embedding)) return;
        }
      }
      const files: IndexedFile[] = stored.files.map((file) => ({
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        hash: file.hash,
        bytes: file.bytes,
        truncated: file.truncated === true,
        chunks: file.chunks.map((chunk): IndexedChunk => {
          const embedding = chunk.embedding ? decodeEmbedding(chunk.embedding) : undefined;
          return {
            id: chunk.id,
            file: chunk.file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            normalized: normalizeText(chunk.content),
            terms: new Map(chunk.terms),
            symbols: chunk.symbols,
            types: chunk.types,
            imports: chunk.imports,
            calls: chunk.calls,
            structural: chunk.structural,
            ...(embedding ? { embedding } : {}),
          };
        }),
      }));
      const residentBytes = estimateIndexMemoryBytes(files);
      if (residentBytes > MAX_RESIDENT_INDEX_BYTES) return;
      this.files = new Map(files.map((file) => [file.path, file]));
      this.chunks = [...this.files.values()].flatMap((file) => file.chunks);
      this.documentFrequency = buildDocumentFrequency(this.chunks);
      this.currentStats = {
        ...stored.stats,
        memory: {
          residentBytes,
          budgetBytes: MAX_RESIDENT_INDEX_BYTES,
        },
      };
      if (migration.migrated) await this.persist();
    } catch {
      // Missing, old or corrupt indexes are rebuilt from source.
    }
  }

  private async persist(): Promise<boolean> {
    if (!this.currentStats) return false;
    // Keep the durable format compact. `normalized` is derived from content on
    // load and embeddings are quantized to Float32 before base64 encoding.
    const files: StoredFile[] = [...this.files.values()].map((file) => ({
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash: file.hash,
      bytes: file.bytes,
      truncated: file.truncated,
      chunks: file.chunks.map((chunk) => ({
        id: chunk.id,
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        terms: [...chunk.terms.entries()],
        symbols: chunk.symbols,
        types: chunk.types,
        imports: chunk.imports,
        calls: chunk.calls,
        structural: chunk.structural,
        ...(chunk.embedding?.length ? { embedding: encodeEmbedding(chunk.embedding) } : {}),
      })),
    }));
    const body = {
      version: INDEX_VERSION,
      rootHash: this.rootHash,
      files,
      stats: this.currentStats,
    };
    const serialized = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(serialized) > MAX_PERSISTED_INDEX_BYTES) {
      await unlink(this.indexPath).catch(() => undefined);
      return false;
    }
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.indexPath);
    return true;
  }

  /** Drop optional vectors before they can consume the daemon's resident budget. */
  private enforceResidentBudget(): void {
    if (this.estimateResidentBytes() <= MAX_RESIDENT_INDEX_BYTES) return;
    for (const file of this.files.values()) {
      for (const chunk of file.chunks) chunk.embedding = undefined;
    }
  }

  private estimateResidentBytes(): number {
    return estimateIndexMemoryBytes([...this.files.values()]);
  }
}

async function collectSourceFiles(
  root: string,
): Promise<{ root: string; paths: string[]; truncated: boolean }> {
  const canonicalRoot = await realpath(root).catch(() => root);
  const paths: string[] = [];
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    if (paths.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort(
      (left, right) =>
        sourcePriority(left.name) - sourcePriority(right.name) ||
        left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (paths.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        assertInside(canonicalRoot, absolutePath);
        paths.push(absolutePath);
      }
    }
  };
  await visit(canonicalRoot);
  return { root: canonicalRoot, paths, truncated };
}

function chunkFile(file: string, content: string): { chunks: IndexedChunk[]; truncated: boolean } {
  const lines = content.split(/\r?\n/);
  const facts = analyzeStructure(file, content);
  const output: IndexedChunk[] = [];
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
  for (let offset = 0; offset < lines.length; offset += step) {
    const slice = lines.slice(offset, offset + CHUNK_LINES);
    if (slice.every((line) => !line.trim())) continue;
    const startLine = offset + 1;
    const endLine = Math.min(lines.length, offset + slice.length);
    const relevant = facts.filter((fact) => fact.line >= startLine && fact.line <= endLine);
    const symbols = uniqueFacts(relevant, 'symbol');
    const types = uniqueFacts(relevant, 'type');
    const imports = uniqueFacts(relevant, 'import');
    const calls = uniqueFacts(relevant, 'call');
    const structural = relevant
      .map((fact) => `${fact.kind}:${fact.name} ${fact.detail}`)
      .join('\n');
    const chunkContent = slice.join('\n').trimEnd();
    const terms = termFrequency(`${file}\n${structural}\n${chunkContent}`);
    output.push({
      id: createHash('sha256')
        .update(`${file}:${startLine}:${chunkContent}`)
        .digest('hex')
        .slice(0, 24),
      file,
      startLine,
      endLine,
      content: chunkContent,
      normalized: normalizeText(chunkContent),
      terms,
      symbols,
      types,
      imports,
      calls,
      structural,
    });
    if (offset + CHUNK_LINES >= lines.length) break;
  }
  if (output.length <= MAX_CHUNKS_PER_FILE) {
    return { chunks: output, truncated: false };
  }
  return {
    chunks: selectRepresentativeChunks(output, MAX_CHUNKS_PER_FILE),
    truncated: true,
  };
}

function analyzeStructure(file: string, content: string): StructuralFact[] {
  const extension = extname(file).toLowerCase();
  if (
    content.length <= MAX_AST_FILE_BYTES &&
    ['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(extension)
  ) {
    try {
      return analyzeTypeScript(file, content, extension);
    } catch {
      // Generated compiler baselines can intentionally contain parser-crash
      // reproducers. Keep the index available with the bounded structural
      // fallback instead of trusting every source file to be parseable.
      return analyzeLanguageStructure(content, extension);
    }
  }
  return analyzeLanguageStructure(content, extension);
}

function analyzeTypeScript(file: string, content: string, extension: string): StructuralFact[] {
  const kind =
    extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : extension === '.js' || extension === '.mjs'
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  const facts: StructuralFact[] = [];
  const add = (
    node: ts.Node,
    factKind: StructuralFact['kind'],
    name: string,
    detail = '',
  ): void => {
    const clean = name.trim();
    if (!clean || clean.length > 240) return;
    facts.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source, false)).line + 1,
      kind: factKind,
      name: clean,
      detail: detail.slice(0, 500),
    });
  };
  const textOfName = (node: ts.NamedDeclaration): string =>
    node.name && ts.isIdentifier(node.name) ? node.name.text : (node.name?.getText(source) ?? '');
  const inspect = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isVariableDeclaration(node)
    ) {
      const name = textOfName(node);
      if (name) {
        add(node, 'symbol', name, ts.SyntaxKind[node.kind]);
        if ('type' in node && node.type)
          add(node, 'type', node.type.getText(source), `for ${name}`);
      }
      if ('typeParameters' in node && node.typeParameters) {
        for (const parameter of node.typeParameters) {
          add(parameter, 'type', parameter.getText(source), `generic of ${name}`);
        }
      }
    } else if (ts.isParameter(node) && node.type) {
      add(node, 'type', node.type.getText(source), `parameter ${textOfName(node)}`);
    } else if (ts.isImportDeclaration(node)) {
      add(node, 'import', String(node.moduleSpecifier.getText(source)).replace(/^['"]|['"]$/g, ''));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, 'import', String(node.moduleSpecifier.getText(source)).replace(/^['"]|['"]$/g, ''));
    } else if (ts.isCallExpression(node)) {
      add(node, 'call', node.expression.getText(source).slice(0, 240));
    }
  };
  const pending: ts.Node[] = [source];
  let visited = 0;
  while (pending.length > 0 && visited < 150_000 && facts.length < MAX_FACTS_PER_FILE) {
    const node = pending.pop();
    if (!node) break;
    visited += 1;
    inspect(node);
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return facts.slice(0, MAX_FACTS_PER_FILE);
}

function analyzeLanguageStructure(content: string, extension = ''): StructuralFact[] {
  const facts: StructuralFact[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<{
    kind: StructuralFact['kind'];
    expression: RegExp;
    detail?: string;
  }> = [
    {
      kind: 'symbol',
      expression:
        /^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:class|interface|enum|struct|trait|module|namespace|def|fn|func|function)\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: 'type',
      expression: /^\s*(?:export\s+)?(?:type|typedef)\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: 'import',
      expression:
        /^\s*(?:import|from|require|use|using|include)\s*(?:\(|["'<])?([A-Za-z0-9_@./:$-]+)/,
    },
    {
      kind: 'call',
      expression: /\b([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\(/,
    },
  ];
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      const match = pattern.expression.exec(line);
      const name = match?.[1];
      if (name && !COMMON_CALLS.has(name)) {
        facts.push({ line: index + 1, kind: pattern.kind, name, detail: pattern.detail ?? '' });
      }
    }
    const annotations = line.matchAll(
      /(?:^|[,(]\s*)([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$<>,.[\]| ?]*)/g,
    );
    for (const annotation of annotations) {
      if (annotation[2]) {
        facts.push({
          line: index + 1,
          kind: 'type',
          name: annotation[2].trim(),
          detail: `annotation for ${annotation[1] ?? 'value'}`,
        });
      }
    }
    for (const fact of languageAwareFacts(line, extension)) {
      facts.push({ ...fact, line: index + 1 });
    }
    if (facts.length >= MAX_FACTS_PER_FILE) break;
  }
  return dedupeStructuralFacts(facts).slice(0, MAX_FACTS_PER_FILE);
}

function languageAwareFacts(line: string, extension: string): Array<Omit<StructuralFact, 'line'>> {
  const facts: Array<Omit<StructuralFact, 'line'>> = [];
  const add = (kind: StructuralFact['kind'], name?: string, detail = ''): void => {
    const clean = name?.trim();
    if (!clean || clean.length > 240 || COMMON_CALLS.has(clean)) return;
    facts.push({ kind, name: clean, detail: detail.slice(0, 500) });
  };
  const parameters = (value: string, separator: RegExp, typeFirst = false): void => {
    for (const raw of value.split(',')) {
      const clean = raw
        .trim()
        .replace(/=.*/, '')
        .replace(/\b(?:mut|ref|out|in)\s+/g, '');
      const match = separator.exec(clean);
      if (!match) continue;
      const type = (typeFirst ? match[1] : match[2])?.trim();
      const name = (typeFirst ? match[2] : match[1])?.trim();
      add('type', type, name ? `parameter ${name}` : 'parameter');
    }
  };

  if (extension === '.py') {
    const declaration =
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?/.exec(line);
    if (declaration) {
      add('symbol', declaration[1], 'python function');
      parameters(declaration[2] ?? '', /^([A-Za-z_]\w*)\s*:\s*(.+)$/);
      add('type', declaration[3], `return of ${declaration[1]}`);
    }
    const classDeclaration = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(line);
    if (classDeclaration) {
      add('symbol', classDeclaration[1], 'python class');
      add('type', classDeclaration[1], 'python class');
      for (const base of (classDeclaration[2] ?? '').split(',')) add('type', base, 'base class');
    }
    const importDeclaration = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
    add('import', importDeclaration?.[1] ?? importDeclaration?.[2], 'python import');
  }

  if (['.java', '.kt', '.kts', '.cs'].includes(extension)) {
    const typeDeclaration =
      /^\s*(?:public|private|protected|internal|abstract|final|sealed|static|data|record|\s)*\b(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/.exec(
        line,
      );
    if (typeDeclaration) {
      add('symbol', typeDeclaration[1], 'nominal type');
      add('type', typeDeclaration[1], 'nominal type');
    }
    const method =
      /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|suspend|open)\s+)*([A-Za-z_$][\w$<>,.?[\] ]*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(
        line,
      );
    if (method && !['if', 'for', 'while', 'switch', 'catch'].includes(method[2] ?? '')) {
      add('symbol', method[2], `${extension.slice(1)} method`);
      add('type', method[1], `return of ${method[2]}`);
      parameters(method[3] ?? '', /^(.+?)\s+([A-Za-z_$][\w$]*)$/, true);
    }
    const imported = /^\s*(?:import|using)\s+(?:static\s+)?([A-Za-z_$][\w$.:]*)/.exec(line);
    add('import', imported?.[1], `${extension.slice(1)} import`);
  }

  if (extension === '.go') {
    const declaration = /^\s*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(.*)$/.exec(
      line,
    );
    if (declaration) {
      add('symbol', declaration[1], 'go function');
      parameters(declaration[2] ?? '', /^([A-Za-z_]\w*)\s+(.+)$/);
      const returns = (declaration[3] ?? '').replace(/^\(|\)$/g, '').trim();
      if (returns) add('type', returns, `return of ${declaration[1]}`);
    }
    const typeDeclaration = /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|=)?/.exec(line);
    if (typeDeclaration) {
      add('symbol', typeDeclaration[1], 'go type');
      add('type', typeDeclaration[1], 'go type');
    }
    const imported = /^\s*(?:import\s+)?(?:[A-Za-z_]\w*\s+)?["`]([^"`]+)["`]/.exec(line);
    add('import', imported?.[1], 'go import');
  }

  if (extension === '.rs') {
    const declaration =
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/.exec(
        line,
      );
    if (declaration) {
      add('symbol', declaration[1], 'rust function');
      parameters(declaration[2] ?? '', /^([A-Za-z_]\w*)\s*:\s*(.+)$/);
      add('type', declaration[3], `return of ${declaration[1]}`);
    }
    const typeDeclaration =
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/.exec(line);
    if (typeDeclaration) {
      add('symbol', typeDeclaration[1], 'rust type');
      add('type', typeDeclaration[1], 'rust type');
    }
    const imported = /^\s*use\s+([^;]+)/.exec(line);
    add('import', imported?.[1], 'rust use');
  }
  return facts;
}

function dedupeStructuralFacts(facts: StructuralFact[]): StructuralFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.line}:${fact.kind}:${fact.name}:${fact.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectRepresentativeChunks(chunks: IndexedChunk[], limit: number): IndexedChunk[] {
  if (chunks.length <= limit) return chunks;
  const selected = new Set<number>([0, chunks.length - 1]);
  const coverageSlots = Math.max(2, Math.ceil(limit * 0.65));
  for (let slot = 0; slot < coverageSlots; slot += 1) {
    selected.add(Math.round((slot / Math.max(1, coverageSlots - 1)) * (chunks.length - 1)));
  }
  const byStructure = chunks
    .map((chunk, index) => ({
      index,
      score:
        chunk.symbols.length * 5 +
        chunk.types.length * 3 +
        chunk.imports.length * 2 +
        chunk.calls.length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const candidate of byStructure) {
    if (selected.size >= limit) break;
    selected.add(candidate.index);
  }
  for (let index = 0; selected.size < limit && index < chunks.length; index += 1) {
    selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => chunks[index])
    .filter((chunk): chunk is IndexedChunk => Boolean(chunk));
}

function uniqueFacts(facts: StructuralFact[], kind: StructuralFact['kind']): string[] {
  return [
    ...new Set(
      facts
        .filter((fact) => fact.kind === kind)
        .map((fact) => fact.name)
        .filter((name) => name.length > 1 && !COMMON_CALLS.has(name)),
    ),
  ].slice(0, 64);
}

function scoreChunk(
  chunk: IndexedChunk,
  queryTerms: string[],
  phrase: string,
  documentFrequency: Map<string, number>,
  chunkCount: number,
): number {
  let score = 0;
  const normalizedPath = normalizeText(chunk.file);
  const symbolText = normalizeText(chunk.symbols.join(' '));
  const typeText = normalizeText(chunk.types.join(' '));
  const importText = normalizeText(chunk.imports.join(' '));
  const callText = normalizeText(chunk.calls.join(' '));
  for (const term of new Set(queryTerms)) {
    const frequency = chunk.terms.get(term) ?? 0;
    if (frequency === 0) continue;
    const documents = documentFrequency.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (chunkCount - documents + 0.5) / (documents + 0.5),
    );
    score += inverseDocumentFrequency * ((frequency * 2.2) / (frequency + 1.2));
    if (normalizedPath.includes(term)) score += 1.8;
    if (symbolText.includes(term)) score += 3.2;
    if (typeText.includes(term)) score += 2.6;
    if (importText.includes(term)) score += 2;
    if (callText.includes(term)) score += 1.6;
  }
  if (phrase.length >= 4 && chunk.normalized.includes(phrase)) score += 5;
  return score;
}

function buildDocumentFrequency(chunks: IndexedChunk[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const chunk of chunks) {
    for (const term of chunk.terms.keys()) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return frequencies;
}

/**
 * Conservative resident-size estimate used before accepting a persisted or
 * newly built index. V8 object headers vary by runtime, so this intentionally
 * overestimates strings, map entries, and array elements. It is a guardrail,
 * not a replacement for the process RSS benchmark.
 */
function estimateIndexMemoryBytes(
  files: ReadonlyArray<{
    path: string;
    hash?: string;
    chunks: ReadonlyArray<{
      content?: unknown;
      normalized?: unknown;
      structural?: unknown;
      terms?: unknown;
      symbols?: unknown;
      types?: unknown;
      imports?: unknown;
      calls?: unknown;
      embedding?: unknown;
    }>;
  }>,
): number {
  let total = 0;
  for (const file of files) {
    total += 512 + byteLength(file.path) + byteLength(file.hash);
    for (const chunk of file.chunks) {
      total += 768;
      total += byteLength(chunk.content) * 2;
      total += byteLength(chunk.normalized) * 2;
      total += byteLength(chunk.structural) * 2;
      total += estimateCollectionBytes(chunk.terms, 72);
      total += estimateCollectionBytes(chunk.symbols, 40);
      total += estimateCollectionBytes(chunk.types, 40);
      total += estimateCollectionBytes(chunk.imports, 40);
      total += estimateCollectionBytes(chunk.calls, 40);
      if (Array.isArray(chunk.embedding)) {
        total += 64 + chunk.embedding.length * 4;
      } else if (typeof chunk.embedding === 'string') {
        total += 64 + byteLength(chunk.embedding) * 2;
      }
    }
  }
  return total;
}

function estimateIndexedFileBytes(file: IndexedFile): number {
  return estimateIndexMemoryBytes([file]);
}

function estimateCollectionBytes(value: unknown, perItem: number): number {
  if (value instanceof Map) {
    let total = 64;
    for (const [key, item] of value) total += perItem + byteLength(key) + byteLength(item);
    return total;
  }
  if (!Array.isArray(value)) return 0;
  let total = 64;
  for (const item of value) {
    total += perItem + (typeof item === 'string' ? byteLength(item) : 0);
  }
  return total;
}

function byteLength(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : 0;
}

function isBoundedStringArray(value: unknown, max = 64): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === 'string' && item.length <= 240)
  );
}

function encodeEmbedding(vector: number[]): string {
  const values = Float32Array.from(vector.slice(0, MAX_EMBEDDING_DIMENSIONS));
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

function decodeEmbedding(value: unknown): number[] | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 6_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length % 4 !== 0 || bytes.length / 4 > MAX_EMBEDDING_DIMENSIONS) {
    return undefined;
  }
  // Do not create a typed-array view over the Buffer: pooled Node buffers can
  // have an unaligned byteOffset, which would throw for an otherwise valid
  // embedding. Reading little-endian scalars is a little slower on load but
  // keeps persistence portable across runtimes.
  const output = Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    bytes.readFloatLE(index * 4),
  );
  return output.every((item) => Number.isFinite(item)) ? output : undefined;
}

function termFrequency(value: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokenize(value, MAX_TERMS_PER_CHUNK * 4)) {
    frequencies.set(token, Math.min(16, (frequencies.get(token) ?? 0) + 1));
    if (frequencies.size >= MAX_TERMS_PER_CHUNK) break;
  }
  return frequencies;
}

function tokenize(value: string, limit = 1_000): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return normalizeText(expanded)
    .split(/[^a-z0-9_$@/.-]+/)
    .flatMap((token) => token.split(/[._$/@-]+/))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, limit);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftLength += a * a;
    rightLength += b * b;
  }
  return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength) || 1);
}

async function requestEmbeddings(
  baseUrl: string,
  model: string,
  input: string[],
): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, truncate: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Ollama embedding request failed (${response.status}).`);
    const body = (await response.json()) as { embeddings?: unknown };
    if (
      !Array.isArray(body.embeddings) ||
      body.embeddings.length !== input.length ||
      !body.embeddings.every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length > 0 &&
          vector.length <= MAX_EMBEDDING_DIMENSIONS &&
          vector.every((value) => typeof value === 'number' && Number.isFinite(value)),
      )
    ) {
      throw new Error('Ollama returned an invalid embedding response.');
    }
    return body.embeddings as number[][];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLoopbackBaseUrl(value?: string): string {
  const raw = value?.trim() || 'http://127.0.0.1:11434';
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('Hawk local embeddings may only use a loopback Ollama URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported Ollama URL protocol.');
  }
  return url.toString().replace(/\/$/, '');
}

function assertInside(root: string, candidate: string): void {
  const path = relative(resolve(root), resolve(candidate));
  if (path.startsWith('..') || isAbsolute(path)) {
    throw new Error('Semantic index path escapes the workspace.');
  }
}

function sourcePriority(name: string): number {
  const normalized = name.toLowerCase();
  if (['src', 'source'].includes(normalized)) return 0;
  if (['app', 'apps', 'lib', 'packages', 'server'].includes(normalized)) return 1;
  if (['test', 'tests', '__tests__', 'fixtures', 'baselines'].includes(normalized)) return 8;
  if (['docs', 'examples', 'samples'].includes(normalized)) return 9;
  return 4;
}

const COMMON_CALLS = new Set(['catch', 'console', 'for', 'if', 'map', 'return', 'switch', 'while']);

const STOP_WORDS = new Set([
  'and',
  'are',
  'const',
  'else',
  'for',
  'from',
  'function',
  'import',
  'return',
  'that',
  'the',
  'this',
  'with',
]);
