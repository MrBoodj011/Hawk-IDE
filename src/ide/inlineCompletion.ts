import * as config from '../config/config.js';
import type { Client } from '../llm/client.js';
import { createRoutedClient } from '../llm/routing.js';
import type { Message } from '../llm/types.js';
import type { SemanticWorkspaceIndex } from './semanticIndex.js';

const MAX_PREFIX_CHARS = 12_000;
const MAX_SUFFIX_CHARS = 4_000;
const MAX_COMPLETION_CHARS = 8_000;
const COMPLETION_TIMEOUT_MS = 12_000;

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
  const related = index.search(query, 4);
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
      provider: client.name(),
      model: client.model(),
      latencyMs: Date.now() - startedAt,
      contextFiles: related.map((result) => result.file),
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
