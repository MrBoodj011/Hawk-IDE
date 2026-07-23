import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditPredictionEngine, type EditPredictionPredictor } from './editPredictionEngine.js';
import type { EditPredictionRequest, MultiFileEditPredictionRequest } from './inlineCompletion.js';
import { SemanticWorkspaceIndex } from './semanticIndex.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('EditPredictionEngine', () => {
  it('deduplicates concurrent requests and serves an exact cached prediction', async () => {
    const fixture = await createFixture();
    let calls = 0;
    const predictor: EditPredictionPredictor = async () => {
      calls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return prediction('validateToken(token);', 30);
    };
    const engine = new EditPredictionEngine(fixture.root, fixture.index, {
      storageRoot: fixture.scorecard,
      predictor,
      routeFingerprint: () => 'test-route',
    });
    await engine.initialize();

    const [first, joined] = await Promise.all([
      engine.predict(request()),
      engine.predict(request()),
    ]);
    const cached = await engine.predict(request());

    expect(calls).toBe(1);
    expect(new Set([first.cacheKind, joined.cacheKind])).toEqual(new Set(['miss', 'in-flight']));
    expect(cached.cacheKind).toBe('exact');
    expect(cached.cached).toBe(true);
    expect(cached.latencyMs).toBeLessThan(10);
    expect(
      engine.recordFeedback({ predictionId: cached.predictionId, outcome: 'accepted' }),
    ).toEqual({ recorded: true });
    expect(
      engine.recordFeedback({ predictionId: cached.predictionId, outcome: 'accepted' }),
    ).toMatchObject({ recorded: false, reason: 'already-recorded' });

    const report = engine.report();
    expect(report.cache).toMatchObject({
      requests: 3,
      exactHits: 1,
      inFlightJoins: 1,
      misses: 1,
    });
    expect(report.models[0]).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      generations: 1,
      suggestionsServed: 3,
      accepted: 1,
    });
    await engine.dispose();
  });

  it('reuses the remaining insertion when the operator types its first characters', async () => {
    const fixture = await createFixture();
    let calls = 0;
    const engine = new EditPredictionEngine(fixture.root, fixture.index, {
      storageRoot: fixture.scorecard,
      routeFingerprint: () => 'test-route',
      predictor: async () => {
        calls += 1;
        return prediction('validateToken(token);', 20);
      },
    });
    await engine.initialize();

    const first = await engine.predict(request());
    const continued = await engine.predict({
      ...request(),
      prefix: `${request().prefix}validate`,
    });

    expect(first.text).toBe('validateToken(token);');
    expect(continued).toMatchObject({
      text: 'Token(token);',
      cacheKind: 'continuation',
      cached: true,
    });
    expect(calls).toBe(1);
    await engine.dispose();
  });

  it('persists only aggregate model evaluation across daemon restarts', async () => {
    const fixture = await createFixture();
    const first = new EditPredictionEngine(fixture.root, fixture.index, {
      storageRoot: fixture.scorecard,
      routeFingerprint: () => 'test-route',
      predictor: async () => prediction('validateToken(token);', 25),
    });
    await first.initialize();
    const offered = await first.predict(request());
    first.recordFeedback({ predictionId: offered.predictionId, outcome: 'rejected' });
    await first.dispose();

    const second = new EditPredictionEngine(fixture.root, fixture.index, {
      storageRoot: fixture.scorecard,
      routeFingerprint: () => 'test-route',
      predictor: async () => prediction('unused', 1),
    });
    await second.initialize();
    expect(second.report().models[0]).toMatchObject({
      generations: 1,
      validSuggestions: 1,
      rejected: 1,
      feedbackSamples: 1,
    });
    await second.dispose();
  });

  it('caches one coordinated multi-file prediction and records operator feedback', async () => {
    const fixture = await createFixture();
    let calls = 0;
    const engine = new EditPredictionEngine(fixture.root, fixture.index, {
      storageRoot: fixture.scorecard,
      routeFingerprint: () => 'test-route',
      multiFilePredictor: async () => {
        calls += 1;
        return {
          kind: 'multi-file-next-edit',
          summary: 'Coordinate caller and configuration',
          confidence: 0.9,
          edits: [
            {
              file: 'auth.ts',
              oldText: 'validateToken',
              newText: 'validateAccessToken',
              baseSha256: 'a'.repeat(64),
            },
            {
              file: 'client.ts',
              oldText: 'allow',
              newText: 'authorize',
              baseSha256: 'b'.repeat(64),
            },
          ],
          provider: 'test-provider',
          model: 'multi-file-model',
          latencyMs: 40,
          contextFiles: ['auth.ts', 'client.ts'],
        };
      },
    });
    await engine.initialize();

    const first = await engine.predictMultiFile(multiFileRequest());
    const cached = await engine.predictMultiFile(multiFileRequest());

    expect(calls).toBe(1);
    expect(first.cacheKind).toBe('miss');
    expect(cached).toMatchObject({ cacheKind: 'exact', cached: true });
    expect(
      engine.recordFeedback({ predictionId: cached.predictionId, outcome: 'accepted' }),
    ).toEqual({ recorded: true });
    expect(engine.report().models[0]).toMatchObject({
      model: 'multi-file-model',
      generations: 1,
      validSuggestions: 1,
      suggestionsServed: 2,
      accepted: 1,
    });
    await engine.dispose();
  });
});

function request(): EditPredictionRequest {
  return {
    file: 'client.ts',
    languageId: 'typescript',
    prefix: 'export function allow(token: string) {\n  ',
    suffix: '\n}',
    minConfidence: 0.55,
    recentEdits: [
      {
        file: 'auth.ts',
        before: 'return true;',
        after: 'return validateToken(token);',
        line: 4,
      },
    ],
    diagnostics: [],
  };
}

function prediction(text: string, latencyMs: number) {
  return {
    text,
    replaceText: '',
    kind: 'next-edit' as const,
    confidence: 0.91,
    provider: 'test-provider',
    model: 'test-model',
    latencyMs,
    contextFiles: ['auth.ts'],
  };
}

function multiFileRequest(): MultiFileEditPredictionRequest {
  return {
    activeFile: 'auth.ts',
    documents: [
      {
        file: 'auth.ts',
        languageId: 'typescript',
        content: 'export function validateToken(value: string) {}\n',
      },
      {
        file: 'client.ts',
        languageId: 'typescript',
        content: 'export function allow(value: string) { return validateToken(value); }\n',
      },
    ],
    recentEdits: [
      {
        file: 'auth.ts',
        before: 'validate',
        after: 'validateToken',
        line: 1,
      },
    ],
    diagnostics: [],
    minConfidence: 0.55,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hawk-edit-engine-'));
  roots.push(root);
  await writeFile(join(root, 'auth.ts'), 'export function validateToken(value: string) {}\n');
  return {
    root,
    scorecard: join(root, '.scorecard'),
    index: new SemanticWorkspaceIndex(root, { storageRoot: join(root, '.index') }),
  };
}
