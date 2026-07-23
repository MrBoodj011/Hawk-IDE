import { createHash } from 'node:crypto';
import * as config from '../config/config.js';
import type { Client } from '../llm/client.js';
import { createRoutedClient } from '../llm/routing.js';
import type { Message } from '../llm/types.js';
import type { SemanticWorkspaceIndex } from './semanticIndex.js';

const MAX_PREFIX_CHARS = 12_000;
const MAX_SUFFIX_CHARS = 4_000;
const MAX_COMPLETION_CHARS = 8_000;
const MAX_EDIT_CHARS = 16_000;
const MAX_MULTI_FILE_EDITS = 8;
const MAX_MULTI_FILE_CHARS = 80_000;
const MAX_MULTI_FILE_TOTAL_CHARS = 240_000;
const COMPLETION_TIMEOUT_MS = 12_000;
const MULTI_FILE_TIMEOUT_MS = 25_000;

export interface InlineCompletionRequest {
  file: string;
  languageId: string;
  prefix: string;
  suffix: string;
}

export interface InlineCompletionResponse {
  text: string;
  provider?: string;
  model?: string;
  latencyMs: number;
  contextFiles: string[];
}

export interface RecentEdit {
  file: string;
  before: string;
  after: string;
  line: number;
}

export interface EditPredictionRequest extends InlineCompletionRequest {
  recentEdits?: RecentEdit[];
  diagnostics?: string[];
  minConfidence?: number;
}

export interface EditPredictionResponse extends InlineCompletionResponse {
  replaceText: string;
  kind: 'next-edit';
  confidence: number;
}

export interface MultiFileEditPredictionDocument {
  file: string;
  languageId: string;
  content: string;
}

export interface MultiFileEditPredictionRequest {
  activeFile: string;
  documents: MultiFileEditPredictionDocument[];
  recentEdits?: RecentEdit[];
  diagnostics?: string[];
  minConfidence?: number;
}

export interface MultiFilePredictedEdit {
  file: string;
  oldText: string;
  newText: string;
  baseSha256: string;
}

export interface MultiFileEditPredictionResponse {
  kind: 'multi-file-next-edit';
  summary: string;
  confidence: number;
  edits: MultiFilePredictedEdit[];
  provider?: string;
  model?: string;
  latencyMs: number;
  contextFiles: string[];
}

export async function createInlineCompletion(
  request: InlineCompletionRequest,
  index: SemanticWorkspaceIndex,
  options: { client?: Client; timeoutMs?: number } = {},
): Promise<InlineCompletionResponse> {
  const prefix = String(request.prefix ?? '').slice(-MAX_PREFIX_CHARS);
  const suffix = String(request.suffix ?? '').slice(0, MAX_SUFFIX_CHARS);
  const languageId = String(request.languageId ?? 'plaintext').slice(0, 80);
  const file = String(request.file ?? '').slice(0, 1_000);
  if (!prefix.trim()) return { text: '', latencyMs: 0, contextFiles: [] };

  await index.ensureBuilt();
  const query = completionQuery(prefix, file);
  const related = await index.searchHybrid(query, 4);
  const cfg = config.load();
  const client =
    options.client ??
    createRoutedClient(
      {
        ...cfg,
        temperature: 0.1,
        max_tokens: Math.min(cfg.max_tokens ?? 512, 768),
      },
      'fast',
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? COMPLETION_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are Hawk Tab, a precise code completion engine. Return only the code to insert at the cursor. Never use Markdown fences, explanations, or commentary. Continue the existing style and avoid repeating the suffix.',
      },
      {
        role: 'user',
        content: buildCompletionPrompt(file, languageId, prefix, suffix, related),
      },
    ];
    const response = await client.chat({ model: client.model(), messages }, controller.signal);
    return {
      text: sanitizeCompletion(response.message.content, suffix),
      provider: response.route?.provider ?? client.name(),
      model: response.route?.model ?? client.model(),
      latencyMs: Date.now() - startedAt,
      contextFiles: related.map((result) => result.file),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cursor-style next-edit prediction. The model may replace an exact prefix of
 * the text after the cursor, enabling safe multiline changes instead of only
 * appending a completion. A prediction is discarded unless the requested old
 * text exactly matches the current suffix.
 */
export async function createEditPrediction(
  request: EditPredictionRequest,
  index: SemanticWorkspaceIndex,
  options: { client?: Client; timeoutMs?: number } = {},
): Promise<EditPredictionResponse> {
  const prefix = String(request.prefix ?? '').slice(-MAX_PREFIX_CHARS);
  const suffix = String(request.suffix ?? '').slice(0, 12_000);
  const file = String(request.file ?? '').slice(0, 1_000);
  const languageId = String(request.languageId ?? 'plaintext').slice(0, 80);
  const recentEdits = (request.recentEdits ?? []).slice(-6).map((edit) => ({
    file: String(edit.file ?? '').slice(0, 1_000),
    before: String(edit.before ?? '').slice(0, 1_500),
    after: String(edit.after ?? '').slice(0, 1_500),
    line: Number.isFinite(edit.line) ? Math.max(1, Math.floor(edit.line)) : 1,
  }));
  if (!prefix.trim() || recentEdits.length === 0) {
    return {
      text: '',
      replaceText: '',
      kind: 'next-edit',
      confidence: 0,
      latencyMs: 0,
      contextFiles: [],
    };
  }

  await index.ensureBuilt();
  const related = await index.searchHybrid(
    `${file}\n${recentEdits.map((edit) => `${edit.before}\n${edit.after}`).join('\n')}\n${completionQuery(prefix, file)}`,
    4,
  );
  const cfg = config.load();
  const client =
    options.client ??
    createRoutedClient(
      {
        ...cfg,
        temperature: 0.05,
        max_tokens: Math.min(cfg.max_tokens ?? 1_200, 1_800),
      },
      'fast',
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? COMPLETION_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          'You are Hawk Next Edit, a precise multiline edit prediction engine.',
          'Infer the next coherent edit from the recent changes, diagnostics, nearby code, and repository context.',
          'Return one JSON object only: {"old_text":"exact prefix copied from CODE AFTER CURSOR, or empty","new_text":"replacement text","confidence":0.0}.',
          'old_text must be an exact character-for-character prefix of CODE AFTER CURSOR.',
          'confidence must be a number from 0 to 1 reflecting how strongly the recent edits imply this exact change.',
          'Do not modify code unrelated to the pattern demonstrated by the recent edits.',
          'Do not use Markdown, comments about the edit, ellipses, or text outside the JSON object.',
          `Prefer a small high-confidence edit. If confidence is below ${boundedConfidence(request.minConfidence)}, return empty strings.`,
        ].join(' '),
      },
      {
        role: 'user',
        content: buildEditPrompt({
          file,
          languageId,
          prefix,
          suffix,
          recentEdits,
          diagnostics: (request.diagnostics ?? []).slice(0, 20),
          related,
        }),
      },
    ];
    const response = await client.chat({ model: client.model(), messages }, controller.signal);
    const parsed = parseEditPrediction(
      response.message.content,
      suffix,
      boundedConfidence(request.minConfidence),
    );
    return {
      ...parsed,
      kind: 'next-edit',
      provider: response.route?.provider ?? client.name(),
      model: response.route?.model ?? client.model(),
      latencyMs: Date.now() - startedAt,
      contextFiles: related.map((result) => result.file),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Predicts one coordinated change across two or more existing workspace files.
 *
 * Every proposed replacement is bound to the SHA-256 digest of the complete
 * document snapshot supplied by the IDE. The model must copy a unique exact
 * old_text from each document, so the extension can reject drift or ambiguous
 * replacements before creating one atomic WorkspaceEdit.
 */
export async function createMultiFileEditPrediction(
  request: MultiFileEditPredictionRequest,
  index: SemanticWorkspaceIndex,
  options: { client?: Client; timeoutMs?: number } = {},
): Promise<MultiFileEditPredictionResponse> {
  const minConfidence = boundedConfidence(request.minConfidence);
  const documents = normalizeMultiFileDocuments(request.documents);
  const empty = (): MultiFileEditPredictionResponse => ({
    kind: 'multi-file-next-edit',
    summary: '',
    confidence: 0,
    edits: [],
    latencyMs: 0,
    contextFiles: documents.map((document) => document.file),
  });
  if (documents.length < 2) return empty();

  const recentEdits = (request.recentEdits ?? []).slice(-8).map((edit) => ({
    file: normalizeRelativeFile(edit.file),
    before: String(edit.before ?? '').slice(0, 1_500),
    after: String(edit.after ?? '').slice(0, 1_500),
    line: Number.isFinite(edit.line) ? Math.max(1, Math.floor(edit.line)) : 1,
  }));
  if (recentEdits.length === 0) return empty();

  await index.ensureBuilt();
  const related = await index.searchHybrid(
    [
      normalizeRelativeFile(request.activeFile),
      ...recentEdits.map((edit) => `${edit.file}\n${edit.before}\n${edit.after}`),
    ].join('\n'),
    8,
  );
  const cfg = config.load();
  const client =
    options.client ??
    createRoutedClient(
      {
        ...cfg,
        temperature: 0.05,
        max_tokens: Math.min(cfg.max_tokens ?? 3_000, 4_000),
      },
      'fast',
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? MULTI_FILE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          'You are Hawk Multi-File Next Edit, a precise coordinated edit prediction engine.',
          'Infer the smallest coherent next change implied by recent operator edits and current diagnostics.',
          'Return one JSON object only: {"summary":"short reason","confidence":0.0,"edits":[{"file":"exact provided path","old_text":"unique exact text copied from that file","new_text":"replacement"}]}.',
          'Return between 2 and 8 edits targeting distinct provided files.',
          'old_text must be non-empty, exact, character-for-character, and occur exactly once in the complete supplied file.',
          'Never create, rename, or delete files. Never invent a path. Never include Markdown or text outside the JSON object.',
          'Keep every replacement focused and preserve formatting. Do not change unrelated code.',
          `If a coordinated multi-file edit is not strongly implied or confidence is below ${minConfidence}, return {"summary":"","confidence":0,"edits":[]}.`,
        ].join(' '),
      },
      {
        role: 'user',
        content: buildMultiFileEditPrompt({
          activeFile: normalizeRelativeFile(request.activeFile),
          documents,
          recentEdits,
          diagnostics: (request.diagnostics ?? [])
            .slice(0, 40)
            .map((diagnostic) => String(diagnostic).slice(0, 600)),
          related,
        }),
      },
    ];
    const response = await client.chat({ model: client.model(), messages }, controller.signal);
    const parsed = parseMultiFileEditPrediction(response.message.content, documents, minConfidence);
    return {
      ...parsed,
      kind: 'multi-file-next-edit',
      provider: response.route?.provider ?? client.name(),
      model: response.route?.model ?? client.model(),
      latencyMs: Date.now() - startedAt,
      contextFiles: documents.map((document) => document.file),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildCompletionPrompt(
  file: string,
  languageId: string,
  prefix: string,
  suffix: string,
  related: ReturnType<SemanticWorkspaceIndex['search']>,
): string {
  const context = related
    .map(
      (result) =>
        `Related ${result.file}:${result.startLine}-${result.endLine}\n${result.preview.slice(0, 2_500)}`,
    )
    .join('\n\n');
  return [
    `File: ${file}`,
    `Language: ${languageId}`,
    context ? `Workspace context:\n${context}` : '',
    `Code before cursor:\n${prefix}`,
    `Code after cursor:\n${suffix}`,
    'Insert:',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildEditPrompt(input: {
  file: string;
  languageId: string;
  prefix: string;
  suffix: string;
  recentEdits: RecentEdit[];
  diagnostics: string[];
  related: Awaited<ReturnType<SemanticWorkspaceIndex['searchHybrid']>>;
}): string {
  const edits = input.recentEdits
    .map(
      (edit, index) =>
        `Edit ${index + 1} · ${edit.file}:${edit.line}\nBEFORE:\n${edit.before}\nAFTER:\n${edit.after}`,
    )
    .join('\n\n');
  const context = input.related
    .map(
      (result) =>
        `Related ${result.file}:${result.startLine}-${result.endLine} · symbols ${result.symbols.join(', ')} · types ${result.types.join(', ')}\n${result.preview.slice(0, 2_000)}`,
    )
    .join('\n\n');
  return [
    `File: ${input.file}`,
    `Language: ${input.languageId}`,
    `RECENT EDITS:\n${edits}`,
    input.diagnostics.length
      ? `DIAGNOSTICS:\n${input.diagnostics.map((item) => String(item).slice(0, 600)).join('\n')}`
      : '',
    context ? `REPOSITORY CONTEXT:\n${context}` : '',
    `CODE BEFORE CURSOR:\n${input.prefix}`,
    `CODE AFTER CURSOR:\n${input.suffix}`,
    'JSON:',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildMultiFileEditPrompt(input: {
  activeFile: string;
  documents: MultiFileEditPredictionDocument[];
  recentEdits: RecentEdit[];
  diagnostics: string[];
  related: Awaited<ReturnType<SemanticWorkspaceIndex['searchHybrid']>>;
}): string {
  const edits = input.recentEdits
    .map(
      (edit, index) =>
        `Edit ${index + 1} - ${edit.file}:${edit.line}\nBEFORE:\n${edit.before}\nAFTER:\n${edit.after}`,
    )
    .join('\n\n');
  const related = input.related
    .map(
      (result) =>
        `${result.file}:${result.startLine}-${result.endLine} - symbols ${result.symbols.join(', ')} - types ${result.types.join(', ')}`,
    )
    .join('\n');
  const documents = input.documents
    .map(
      (document) =>
        `FILE ${document.file}\nLANGUAGE ${document.languageId}\nSHA256 ${sha256(document.content)}\nCONTENT START\n${document.content}\nCONTENT END`,
    )
    .join('\n\n');
  return [
    `ACTIVE FILE: ${input.activeFile}`,
    `RECENT OPERATOR EDITS:\n${edits}`,
    input.diagnostics.length ? `DIAGNOSTICS:\n${input.diagnostics.join('\n')}` : '',
    related ? `SEMANTIC RELATIONS:\n${related}` : '',
    `COMPLETE CANDIDATE DOCUMENTS:\n${documents}`,
    'JSON:',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function completionQuery(prefix: string, file: string): string {
  const lines = prefix.split(/\r?\n/);
  const tail = lines.slice(-12).join('\n');
  return `${file}\n${tail}`.slice(-2_500);
}

function sanitizeCompletion(value: string, suffix: string): string {
  let completion = value
    .replace(/^```[\w+-]*\s*/i, '')
    .replace(/\s*```$/, '')
    .slice(0, MAX_COMPLETION_CHARS);
  if (suffix && completion.endsWith(suffix.slice(0, Math.min(200, suffix.length)))) {
    completion = completion.slice(0, -Math.min(200, suffix.length));
  }
  return completion;
}

function parseEditPrediction(
  value: string,
  suffix: string,
  minConfidence: number,
): Pick<EditPredictionResponse, 'text' | 'replaceText' | 'confidence'> {
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { text: '', replaceText: '', confidence: 0 };
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      old_text?: unknown;
      new_text?: unknown;
      confidence?: unknown;
    };
    const replaceText =
      typeof parsed.old_text === 'string' ? parsed.old_text.slice(0, MAX_EDIT_CHARS) : '';
    const text =
      typeof parsed.new_text === 'string' ? parsed.new_text.slice(0, MAX_EDIT_CHARS) : '';
    const confidence =
      typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.6;
    if (
      !text ||
      text === replaceText ||
      !suffix.startsWith(replaceText) ||
      confidence < minConfidence
    ) {
      return { text: '', replaceText: '', confidence };
    }
    return { text, replaceText, confidence };
  } catch {
    return { text: '', replaceText: '', confidence: 0 };
  }
}

function parseMultiFileEditPrediction(
  value: string,
  documents: MultiFileEditPredictionDocument[],
  minConfidence: number,
): Pick<MultiFileEditPredictionResponse, 'summary' | 'confidence' | 'edits'> {
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const invalid = (confidence = 0) => ({ summary: '', confidence, edits: [] });
  if (start < 0 || end <= start) return invalid();
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      summary?: unknown;
      confidence?: unknown;
      edits?: unknown;
    };
    const confidence =
      typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    if (confidence < minConfidence || !Array.isArray(parsed.edits)) return invalid(confidence);
    if (parsed.edits.length < 2 || parsed.edits.length > MAX_MULTI_FILE_EDITS) {
      return invalid(confidence);
    }
    const byFile = new Map(documents.map((document) => [document.file, document]));
    const seen = new Set<string>();
    const edits: MultiFilePredictedEdit[] = [];
    for (const raw of parsed.edits) {
      if (!raw || typeof raw !== 'object') return invalid(confidence);
      const input = raw as { file?: unknown; old_text?: unknown; new_text?: unknown };
      const file = typeof input.file === 'string' ? normalizeRelativeFile(input.file) : '';
      const oldText =
        typeof input.old_text === 'string' ? input.old_text.slice(0, MAX_EDIT_CHARS) : '';
      const newText =
        typeof input.new_text === 'string' ? input.new_text.slice(0, MAX_EDIT_CHARS) : '';
      const document = byFile.get(file);
      if (
        !file ||
        !document ||
        seen.has(file) ||
        !oldText ||
        oldText === newText ||
        document.content.indexOf(oldText) < 0 ||
        document.content.indexOf(oldText, document.content.indexOf(oldText) + 1) >= 0
      ) {
        return invalid(confidence);
      }
      seen.add(file);
      edits.push({ file, oldText, newText, baseSha256: sha256(document.content) });
    }
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 500) : '',
      confidence,
      edits,
    };
  } catch {
    return invalid();
  }
}

function normalizeMultiFileDocuments(
  documents: MultiFileEditPredictionDocument[],
): MultiFileEditPredictionDocument[] {
  if (!Array.isArray(documents)) return [];
  const output: MultiFileEditPredictionDocument[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of documents.slice(0, MAX_MULTI_FILE_EDITS * 2)) {
    const file = normalizeRelativeFile(raw?.file);
    const content = typeof raw?.content === 'string' ? raw.content : '';
    if (
      !file ||
      seen.has(file) ||
      !content ||
      content.length > MAX_MULTI_FILE_CHARS ||
      total + content.length > MAX_MULTI_FILE_TOTAL_CHARS
    ) {
      continue;
    }
    seen.add(file);
    total += content.length;
    output.push({
      file,
      languageId: String(raw.languageId ?? 'plaintext').slice(0, 80),
      content,
    });
    if (output.length >= MAX_MULTI_FILE_EDITS) break;
  }
  return output;
}

function normalizeRelativeFile(value: unknown): string {
  if (typeof value !== 'string') return '';
  const file = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  if (
    !file ||
    file.startsWith('/') ||
    /^[a-z]:\//i.test(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return '';
  }
  return file.slice(0, 1_000);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedConfidence(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0.3, Math.min(0.95, Number(value))) : 0.55;
}
