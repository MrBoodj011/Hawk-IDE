import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const INDEX_VERSION = 2;
const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 2_500_000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_PERSISTED_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = 10_000;
const MAX_TERMS_PER_CHUNK = 128;
const MAX_FACTS_PER_FILE = 4_000;
const CHUNK_LINES = 64;
const CHUNK_OVERLAP = 12;
const MAX_RESULT_LIMIT = 30;
const EMBEDDING_BATCH_SIZE = 24;
const MAX_EMBEDDING_CHARS = 3_000;
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
  chunks: IndexedChunk[];
}

interface StoredChunk extends Omit<IndexedChunk, 'terms'> {
  terms: Array<[string, number]>;
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
    return await this.commitStats({
      startedAt: Date.now(),
      truncated: false,
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
    const nextFiles = new Map<string, IndexedFile>();
    const changedChunks: IndexedChunk[] = [];
    let bytes = 0;
    let reusedFiles = 0;
    let changedFiles = 0;
    let chunkCount = 0;
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
      const file = relative(this.root, absolutePath).replaceAll('\\', '/');
      const previous = this.files.get(file);
      if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
        nextFiles.set(file, previous);
        bytes += previous.bytes;
        chunkCount += previous.chunks.length;
        reusedFiles += 1;
        continue;
      }
      const indexed = await this.indexOneFile(absolutePath, file, info.size, info.mtimeMs);
      if (!indexed) continue;
      if (chunkCount + indexed.chunks.length > MAX_CHUNKS) {
        truncated = true;
        break;
      }
      nextFiles.set(file, indexed);
      changedChunks.push(...indexed.chunks);
      bytes += indexed.bytes;
      chunkCount += indexed.chunks.length;
      changedFiles += 1;
    }
    changedFiles += [...this.files.keys()].filter((file) => !nextFiles.has(file)).length;
    this.files = nextFiles;
    await this.embedChangedChunks(changedChunks);
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
    return {
      path: file,
      size,
      mtimeMs,
      hash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      chunks: chunkFile(file, content),
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
    if (input.persist !== false) await this.persist();
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
      const stored = JSON.parse(await readFile(this.indexPath, 'utf8')) as StoredIndex;
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
      for (const file of stored.files) {
        if (
          typeof file.path !== 'string' ||
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
      }
      this.files = new Map(
        stored.files.map((file) => [
          file.path,
          {
            ...file,
            chunks: file.chunks.map((chunk) => ({
              ...chunk,
              terms: new Map(chunk.terms),
            })),
          },
        ]),
      );
      this.chunks = [...this.files.values()].flatMap((file) => file.chunks);
      this.documentFrequency = buildDocumentFrequency(this.chunks);
      this.currentStats = stored.stats;
    } catch {
      // Missing, old or corrupt indexes are rebuilt from source.
    }
  }

  private async persist(): Promise<void> {
    if (!this.currentStats) return;
    const body: StoredIndex = {
      version: INDEX_VERSION,
      rootHash: this.rootHash,
      files: [...this.files.values()].map((file) => ({
        ...file,
        chunks: file.chunks.map((chunk) => ({
          ...chunk,
          terms: [...chunk.terms],
        })),
      })),
      stats: this.currentStats,
    };
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.indexPath);
  }
}

async function collectSourceFiles(root: string): Promise<{ paths: string[]; truncated: boolean }> {
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
  return { paths, truncated };
}

function chunkFile(file: string, content: string): IndexedChunk[] {
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
  return output;
}

function analyzeStructure(file: string, content: string): StructuralFact[] {
  const extension = extname(file).toLowerCase();
  if (['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(extension)) {
    try {
      return analyzeTypeScript(file, content, extension);
    } catch {
      // Generated compiler baselines can intentionally contain parser-crash
      // reproducers. Keep the index available with the bounded structural
      // fallback instead of trusting every source file to be parseable.
      return analyzeLanguageStructure(content);
    }
  }
  return analyzeLanguageStructure(content);
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

function analyzeLanguageStructure(content: string): StructuralFact[] {
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
    if (facts.length >= MAX_FACTS_PER_FILE) break;
  }
  return facts;
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
      !body.embeddings.every(
        (vector) => Array.isArray(vector) && vector.every((value) => typeof value === 'number'),
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
