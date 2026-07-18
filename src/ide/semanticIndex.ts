import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const CHUNK_LINES = 56;
const CHUNK_OVERLAP = 10;
const MAX_RESULT_LIMIT = 20;

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

export interface SemanticIndexStats {
  indexedAt: string;
  files: number;
  chunks: number;
  symbols: number;
  bytes: number;
  durationMs: number;
  truncated: boolean;
}

export interface SemanticSearchResult {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  symbols: string[];
  preview: string;
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
}

/**
 * A bounded, local, symbol-aware workspace index. It intentionally avoids
 * sending source to an embedding service: identifiers, paths, comments and
 * nearby code are ranked together with a BM25-style score.
 */
export class SemanticWorkspaceIndex {
  private readonly root: string;
  private chunks: IndexedChunk[] = [];
  private documentFrequency = new Map<string, number>();
  private currentStats: SemanticIndexStats | undefined;
  private building: Promise<SemanticIndexStats> | undefined;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot);
  }

  stats(): SemanticIndexStats | undefined {
    return this.currentStats;
  }

  async ensureBuilt(): Promise<SemanticIndexStats> {
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
    const cleanQuery = query.trim().slice(0, 1_000);
    if (!cleanQuery || this.chunks.length === 0) return [];
    const queryTerms = tokenize(cleanQuery);
    if (queryTerms.length === 0) return [];
    const phrase = normalizeText(cleanQuery);
    const cappedLimit = Math.max(1, Math.min(MAX_RESULT_LIMIT, limit));
    const scored = this.chunks
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, queryTerms, phrase, this.documentFrequency, this.chunks.length),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.file.localeCompare(right.chunk.file) ||
          left.chunk.startLine - right.chunk.startLine,
      )
      .slice(0, cappedLimit);
    return scored.map(({ chunk, score }) => ({
      id: chunk.id,
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: Number(score.toFixed(4)),
      symbols: chunk.symbols.slice(0, 12),
      preview: chunk.content.slice(0, 4_000),
    }));
  }

  private async buildNow(): Promise<SemanticIndexStats> {
    const startedAt = Date.now();
    const files = await collectSourceFiles(this.root);
    const chunks: IndexedChunk[] = [];
    let bytes = 0;
    let indexedFiles = 0;
    let symbols = 0;
    let truncated = files.truncated;

    for (const absolutePath of files.paths) {
      const info = await stat(absolutePath).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
      if (bytes + info.size > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      const content = await readFile(absolutePath, 'utf8').catch(() => '');
      if (!content || content.includes('\u0000')) continue;
      const file = relative(this.root, absolutePath).replaceAll('\\', '/');
      const fileChunks = chunkFile(file, content);
      chunks.push(...fileChunks);
      symbols += fileChunks.reduce((count, chunk) => count + chunk.symbols.length, 0);
      bytes += Buffer.byteLength(content);
      indexedFiles += 1;
    }

    const documentFrequency = new Map<string, number>();
    for (const chunk of chunks) {
      for (const term of chunk.terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.chunks = chunks;
    this.documentFrequency = documentFrequency;
    this.currentStats = {
      indexedAt: new Date().toISOString(),
      files: indexedFiles,
      chunks: chunks.length,
      symbols,
      bytes,
      durationMs: Date.now() - startedAt,
      truncated,
    };
    return this.currentStats;
  }
}

async function collectSourceFiles(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    if (paths.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
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
        paths.push(absolutePath);
      }
    }
  };
  await visit(root);
  return { paths, truncated };
}

function chunkFile(file: string, content: string): IndexedChunk[] {
  const lines = content.split(/\r?\n/);
  const output: IndexedChunk[] = [];
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
  for (let offset = 0; offset < lines.length; offset += step) {
    const slice = lines.slice(offset, offset + CHUNK_LINES);
    if (slice.every((line) => !line.trim())) continue;
    const chunkContent = slice.join('\n').trimEnd();
    const symbolList = extractSymbols(chunkContent);
    const terms = termFrequency(`${file}\n${symbolList.join(' ')}\n${chunkContent}`);
    output.push({
      id: createHash('sha256')
        .update(`${file}:${offset + 1}:${chunkContent}`)
        .digest('hex')
        .slice(0, 20),
      file,
      startLine: offset + 1,
      endLine: Math.min(lines.length, offset + slice.length),
      content: chunkContent,
      normalized: normalizeText(chunkContent),
      terms,
      symbols: symbolList,
    });
    if (offset + CHUNK_LINES >= lines.length) break;
  }
  return output;
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
  for (const term of new Set(queryTerms)) {
    const frequency = chunk.terms.get(term) ?? 0;
    if (frequency === 0) continue;
    const documents = documentFrequency.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (chunkCount - documents + 0.5) / (documents + 0.5),
    );
    score += inverseDocumentFrequency * ((frequency * 2.2) / (frequency + 1.2));
    if (normalizedPath.includes(term)) score += 1.7;
    if (symbolText.includes(term)) score += 2.4;
  }
  if (phrase.length >= 4 && chunk.normalized.includes(phrase)) score += 5;
  return score;
}

function extractSymbols(content: string): string[] {
  const matches = content.matchAll(
    /\b(?:class|interface|type|enum|function|def|fn|struct|trait|module|const|let|var)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*\(/g,
  );
  const symbols = new Set<string>();
  for (const match of matches) {
    const value = match[1] ?? match[2];
    if (value && value.length > 1 && !COMMON_CALLS.has(value)) symbols.add(value);
    if (symbols.size >= 48) break;
  }
  return [...symbols];
}

const COMMON_CALLS = new Set(['catch', 'console', 'for', 'if', 'map', 'return', 'switch', 'while']);

function termFrequency(value: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokenize(value)) {
    frequencies.set(token, Math.min(12, (frequencies.get(token) ?? 0) + 1));
  }
  return frequencies;
}

function tokenize(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return normalizeText(expanded)
    .split(/[^a-z0-9_$.-]+/)
    .flatMap((token) => token.split(/[._$-]+/))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, 8_000);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

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
