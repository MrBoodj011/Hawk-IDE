import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../llm/client.js';
import {
  createEditPrediction,
  createInlineCompletion,
  createMultiFileEditPrediction,
} from './inlineCompletion.js';
import { SemanticWorkspaceIndex } from './semanticIndex.js';

describe('createInlineCompletion', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses local semantic context and strips Markdown fences from the insertion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-inline-'));
    roots.push(root);
    await writeFile(
      join(root, 'auth.ts'),
      'export function validateToken(token: string) { return token.length > 10; }\n',
    );
    let prompt = '';
    const client: Client = {
      name: () => 'test',
      model: () => 'completion-test',
      chat: async (request) => {
        prompt = request.messages.at(-1)?.content ?? '';
        return {
          message: { role: 'assistant', content: '```ts\nreturn validateToken(token);\n```' },
          finishReason: 'stop',
        };
      },
    };
    const result = await createInlineCompletion(
      {
        file: 'handler.ts',
        languageId: 'typescript',
        prefix: 'function allow(token: string) {\n  ',
        suffix: '\n}',
      },
      new SemanticWorkspaceIndex(root),
      { client },
    );

    expect(result.text).toBe('return validateToken(token);');
    expect(result.contextFiles).toContain('auth.ts');
    expect(prompt).toContain('validateToken');
    expect(result.provider).toBe('test');
  });

  it('returns a safe multiline next edit only when old_text exactly matches the suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-edit-prediction-'));
    roots.push(root);
    await writeFile(join(root, 'service.ts'), 'export const timeoutMs = 5000;\n');
    const client: Client = {
      name: () => 'test',
      model: () => 'edit-test',
      chat: async () => ({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            old_text: 'return fetch(url);',
            new_text:
              'return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });\n// guarded request',
            confidence: 0.92,
          }),
        },
        finishReason: 'stop',
        route: { provider: 'fallback-provider', model: 'fallback-edit-model' },
      }),
    };
    const result = await createEditPrediction(
      {
        file: 'client.ts',
        languageId: 'typescript',
        prefix: 'export function request(url: string) {\n  ',
        suffix: 'return fetch(url);\n}',
        recentEdits: [
          {
            file: 'config.ts',
            line: 3,
            before: 'const timeout = 1000;',
            after: 'const timeoutMs = 5000;',
          },
        ],
      },
      new SemanticWorkspaceIndex(root),
      { client },
    );

    expect(result.kind).toBe('next-edit');
    expect(result.confidence).toBe(0.92);
    expect(result.provider).toBe('fallback-provider');
    expect(result.model).toBe('fallback-edit-model');
    expect(result.replaceText).toBe('return fetch(url);');
    expect(result.text).toContain('AbortSignal.timeout');
  });

  it('filters a syntactically valid edit when the model reports low confidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-edit-confidence-'));
    roots.push(root);
    await writeFile(join(root, 'service.ts'), 'export const enabled = true;\n');
    const client: Client = {
      name: () => 'test',
      model: () => 'edit-test',
      chat: async () => ({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            old_text: 'return enabled;',
            new_text: 'return false;',
            confidence: 0.31,
          }),
        },
        finishReason: 'stop',
      }),
    };
    const result = await createEditPrediction(
      {
        file: 'client.ts',
        languageId: 'typescript',
        prefix: 'export function status() {\n  ',
        suffix: 'return enabled;\n}',
        minConfidence: 0.7,
        recentEdits: [
          {
            file: 'service.ts',
            line: 1,
            before: 'export const enabled = false;',
            after: 'export const enabled = true;',
          },
        ],
      },
      new SemanticWorkspaceIndex(root),
      { client },
    );

    expect(result).toMatchObject({ text: '', replaceText: '', confidence: 0.31 });
  });

  it('returns hash-bound coordinated edits only for distinct exact workspace files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-multi-file-edit-'));
    roots.push(root);
    await writeFile(join(root, 'config.ts'), 'export const timeoutMs = 5000;\n');
    await writeFile(
      join(root, 'client.ts'),
      'export function request(url: string) { return fetch(url); }\n',
    );
    const documents = [
      {
        file: 'config.ts',
        languageId: 'typescript',
        content: 'export const timeoutMs = 5000;\n',
      },
      {
        file: 'client.ts',
        languageId: 'typescript',
        content: 'export function request(url: string) { return fetch(url); }\n',
      },
    ];
    const client: Client = {
      name: () => 'test',
      model: () => 'multi-file-test',
      chat: async () => ({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'Coordinate the timeout constant and its caller',
            confidence: 0.93,
            edits: [
              {
                file: 'config.ts',
                old_text: 'export const timeoutMs = 5000;',
                new_text: 'export const timeoutMs = 8000;',
              },
              {
                file: 'client.ts',
                old_text: 'return fetch(url);',
                new_text: 'return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });',
              },
            ],
          }),
        },
        finishReason: 'stop',
      }),
    };

    const result = await createMultiFileEditPrediction(
      {
        activeFile: 'config.ts',
        documents,
        recentEdits: [
          {
            file: 'config.ts',
            line: 1,
            before: 'export const timeout = 5000;',
            after: 'export const timeoutMs = 5000;',
          },
        ],
      },
      new SemanticWorkspaceIndex(root),
      { client },
    );

    expect(result).toMatchObject({
      kind: 'multi-file-next-edit',
      confidence: 0.93,
      summary: 'Coordinate the timeout constant and its caller',
    });
    expect(result.edits).toHaveLength(2);
    expect(result.edits.every((edit) => /^[a-f0-9]{64}$/.test(edit.baseSha256))).toBe(true);
    expect(new Set(result.edits.map((edit) => edit.file))).toEqual(
      new Set(['config.ts', 'client.ts']),
    );
  });

  it('rejects the entire multi-file prediction when one target is ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-multi-file-ambiguous-'));
    roots.push(root);
    await writeFile(join(root, 'a.ts'), 'const enabled = true;\n');
    await writeFile(join(root, 'b.ts'), 'return value;\nreturn value;\n');
    const client: Client = {
      name: () => 'test',
      model: () => 'multi-file-test',
      chat: async () => ({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'ambiguous edit',
            confidence: 0.99,
            edits: [
              { file: 'a.ts', old_text: 'true', new_text: 'false' },
              { file: 'b.ts', old_text: 'return value;', new_text: 'return safeValue;' },
            ],
          }),
        },
        finishReason: 'stop',
      }),
    };

    const result = await createMultiFileEditPrediction(
      {
        activeFile: 'a.ts',
        documents: [
          { file: 'a.ts', languageId: 'typescript', content: 'const enabled = true;\n' },
          {
            file: 'b.ts',
            languageId: 'typescript',
            content: 'return value;\nreturn value;\n',
          },
        ],
        recentEdits: [{ file: 'a.ts', before: 'false', after: 'true', line: 1 }],
      },
      new SemanticWorkspaceIndex(root),
      { client },
    );

    expect(result.edits).toEqual([]);
    expect(result.confidence).toBe(0.99);
  });
});
