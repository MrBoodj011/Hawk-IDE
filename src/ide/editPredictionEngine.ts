import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as config from '../config/config.js';
import {
  type EditPredictionRequest,
  type EditPredictionResponse,
  type MultiFileEditPredictionRequest,
  type MultiFileEditPredictionResponse,
  createEditPrediction,
  createMultiFileEditPrediction,
} from './inlineCompletion.js';
import type { SemanticWorkspaceIndex } from './semanticIndex.js';

const SCORECARD_SCHEMA = 1;
const DEFAULT_CACHE_ENTRIES = 256;
const DEFAULT_CACHE_TTL_MS = 120_000;
const NEGATIVE_CACHE_TTL_MS = 12_000;
const MAX_PENDING_FEEDBACK = 512;
const PENDING_FEEDBACK_TTL_MS = 30 * 60_000;
const MAX_LATENCY_SAMPLES = 200;
const MAX_SCORECARD_BYTES = 2 * 1024 * 1024;

export type EditPredictionCacheKind = 'miss' | 'exact' | 'continuation' | 'in-flight';
export type EditPredictionFeedbackOutcome = 'accepted' | 'rejected';

export interface ManagedEditPredictionResponse extends EditPredictionResponse {
  predictionId: string;
  cached: boolean;
  cacheKind: EditPredictionCacheKind;
}

export interface ManagedMultiFileEditPredictionResponse extends MultiFileEditPredictionResponse {
  predictionId: string;
  cached: boolean;
  cacheKind: 'miss' | 'exact' | 'in-flight';
}

export interface EditPredictionFeedback {
  predictionId: string;
  outcome: EditPredictionFeedbackOutcome;
}

export interface EditPredictionFeedbackResult {
  recorded: boolean;
  reason?: 'unknown-or-expired' | 'already-recorded';
}

export interface EditPredictionModelEvaluation {
  provider: string;
  model: string;
  generations: number;
  validSuggestions: number;
  suggestionsServed: number;
  cacheServed: number;
  inFlightServed: number;
  accepted: number;
  rejected: number;
  feedbackSamples: number;
  feedbackCoverage: number;
  validRate: number;
  acceptanceRate?: number;
  p50GenerationMs?: number;
  p95GenerationMs?: number;
  score: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface EditPredictionEvaluationReport {
  measuredAt: string;
  privacy: string;
  cache: {
    enabled: boolean;
    entries: number;
    maxEntries: number;
    ttlMs: number;
    requests: number;
    exactHits: number;
    continuationHits: number;
    inFlightJoins: number;
    misses: number;
    hitRate: number;
  };
  totals: {
    generations: number;
    validSuggestions: number;
    suggestionsServed: number;
    feedbackSamples: number;
  };
  recommended?: {
    provider: string;
    model: string;
    score: number;
    confidence: 'low' | 'medium' | 'high';
  };
  models: EditPredictionModelEvaluation[];
}

interface ModelState {
  provider: string;
  model: string;
  generations: number;
  validSuggestions: number;
  suggestionsServed: number;
  cacheServed: number;
  inFlightServed: number;
  accepted: number;
  rejected: number;
  latencies: number[];
}

interface StoredScorecard {
  schema: number;
  models: ModelState[];
}

interface NormalizedRequest {
  file: string;
  languageId: string;
  prefix: string;
  suffix: string;
  recentEdits: Array<{ file: string; before: string; after: string; line: number }>;
  diagnostics: string[];
  minConfidence: number;
}

interface CacheEntry {
  key: string;
  routeFingerprint: string;
  indexVersion: string;
  request: NormalizedRequest;
  response: EditPredictionResponse;
  createdAt: number;
  expiresAt: number;
}

interface MultiFileCacheEntry {
  key: string;
  response: MultiFileEditPredictionResponse;
  expiresAt: number;
}

interface PendingFeedback {
  modelKey: string;
  createdAt: number;
}

export type EditPredictionPredictor = (
  request: EditPredictionRequest,
  index: SemanticWorkspaceIndex,
) => Promise<EditPredictionResponse>;

export type MultiFileEditPredictionPredictor = (
  request: MultiFileEditPredictionRequest,
  index: SemanticWorkspaceIndex,
) => Promise<MultiFileEditPredictionResponse>;

export interface EditPredictionEngineOptions {
  storageRoot?: string;
  cacheEnabled?: boolean;
  maxCacheEntries?: number;
  cacheTtlMs?: number;
  predictor?: EditPredictionPredictor;
  multiFilePredictor?: MultiFileEditPredictionPredictor;
  now?: () => Date;
  routeFingerprint?: () => string;
}

/**
 * Low-latency prediction coordinator.
 *
 * It keeps source text only in a bounded in-memory cache. The persistent
 * scorecard stores aggregate counters and latency samples, never prompts,
 * source, diagnostics, file names, or generated edits.
 */
export class EditPredictionEngine {
  private readonly index: SemanticWorkspaceIndex;
  private readonly now: () => Date;
  private readonly predictor: EditPredictionPredictor;
  private readonly multiFilePredictor: MultiFileEditPredictionPredictor;
  private readonly routeFingerprint: () => string;
  private readonly cacheEnabled: boolean;
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;
  private readonly scorecardPath: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<EditPredictionResponse>>();
  private readonly multiFileCache = new Map<string, MultiFileCacheEntry>();
  private readonly multiFileInFlight = new Map<string, Promise<MultiFileEditPredictionResponse>>();
  private readonly pendingFeedback = new Map<string, PendingFeedback>();
  private readonly recordedFeedback = new Map<string, number>();
  private readonly models = new Map<string, ModelState>();
  private persistTimer: NodeJS.Timeout | undefined;
  private persistQueue: Promise<void> = Promise.resolve();
  private cacheRequests = 0;
  private exactHits = 0;
  private continuationHits = 0;
  private inFlightJoins = 0;
  private misses = 0;

  constructor(
    workspaceRoot: string,
    index: SemanticWorkspaceIndex,
    options: EditPredictionEngineOptions = {},
  ) {
    this.index = index;
    this.now = options.now ?? (() => new Date());
    this.predictor =
      options.predictor ??
      (async (request, semanticIndex) => await createEditPrediction(request, semanticIndex));
    this.multiFilePredictor =
      options.multiFilePredictor ??
      (async (request, semanticIndex) =>
        await createMultiFileEditPrediction(request, semanticIndex));
    this.routeFingerprint = options.routeFingerprint ?? configuredRouteFingerprint;
    this.cacheEnabled = options.cacheEnabled ?? process.env.HAWK_IDE_EDIT_CACHE_ENABLED !== '0';
    this.maxCacheEntries = clampInteger(
      options.maxCacheEntries ??
        Number.parseInt(process.env.HAWK_IDE_EDIT_CACHE_MAX_ENTRIES ?? '', 10),
      32,
      512,
      DEFAULT_CACHE_ENTRIES,
    );
    this.cacheTtlMs = clampInteger(
      options.cacheTtlMs ?? Number.parseInt(process.env.HAWK_IDE_EDIT_CACHE_TTL_MS ?? '', 10),
      5_000,
      10 * 60_000,
      DEFAULT_CACHE_TTL_MS,
    );
    const rootHash = createHash('sha256')
      .update(resolve(workspaceRoot).toLowerCase())
      .digest('hex')
      .slice(0, 24);
    const storageRoot =
      options.storageRoot ?? join(homedir(), '.hawk', 'ide', 'prediction-evaluation', rootHash);
    this.scorecardPath = join(storageRoot, 'edit-prediction-scorecard-v1.json');
  }

  async initialize(): Promise<void> {
    try {
      const info = await stat(this.scorecardPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_SCORECARD_BYTES) return;
      const stored = JSON.parse(await readFile(this.scorecardPath, 'utf8')) as StoredScorecard;
      if (
        stored.schema !== SCORECARD_SCHEMA ||
        !Array.isArray(stored.models) ||
        stored.models.length > 100
      ) {
        return;
      }
      for (const candidate of stored.models) {
        const state = normalizeModelState(candidate);
        if (state) this.models.set(modelKey(state.provider, state.model), state);
      }
    } catch {
      // A missing or corrupt aggregate scorecard starts clean.
    }
  }

  async predict(request: EditPredictionRequest): Promise<ManagedEditPredictionResponse> {
    const startedAt = Date.now();
    this.cacheRequests += 1;
    this.cleanup();
    await this.index.ensureBuilt();
    const normalized = normalizeRequest(request);
    const routeFingerprint = this.routeFingerprint();
    const indexVersion = this.index.stats()?.indexedAt ?? 'unbuilt';
    const key = predictionKey(normalized, routeFingerprint, indexVersion);

    if (this.cacheEnabled) {
      const exact = this.cache.get(key);
      if (exact && exact.expiresAt > Date.now()) {
        this.exactHits += 1;
        this.touch(exact);
        return this.serve(exact.response, 'exact', Date.now() - startedAt);
      }
      const continuation = this.findContinuation(normalized, routeFingerprint, indexVersion);
      if (continuation) {
        this.continuationHits += 1;
        this.putCache({
          ...continuation,
          key,
          request: normalized,
          createdAt: Date.now(),
          expiresAt: Date.now() + this.cacheTtlMs,
        });
        return this.serve(continuation.response, 'continuation', Date.now() - startedAt);
      }
    }

    const running = this.inFlight.get(key);
    if (running) {
      this.inFlightJoins += 1;
      const response = await running;
      return this.serve(response, 'in-flight', Date.now() - startedAt);
    }

    this.misses += 1;
    const generated = this.predictor(normalized, this.index);
    this.inFlight.set(key, generated);
    try {
      const response = await generated;
      this.recordGeneration(response);
      if (this.cacheEnabled) {
        const now = Date.now();
        this.putCache({
          key,
          routeFingerprint,
          indexVersion,
          request: normalized,
          response,
          createdAt: now,
          expiresAt: now + (response.text ? this.cacheTtlMs : NEGATIVE_CACHE_TTL_MS),
        });
      }
      return this.serve(response, 'miss', Date.now() - startedAt);
    } finally {
      if (this.inFlight.get(key) === generated) this.inFlight.delete(key);
    }
  }

  async predictMultiFile(
    request: MultiFileEditPredictionRequest,
  ): Promise<ManagedMultiFileEditPredictionResponse> {
    const startedAt = Date.now();
    this.cacheRequests += 1;
    this.cleanup();
    await this.index.ensureBuilt();
    const normalized = normalizeMultiFileRequest(request);
    const routeFingerprint = this.routeFingerprint();
    const indexVersion = this.index.stats()?.indexedAt ?? 'unbuilt';
    const key = createHash('sha256')
      .update(JSON.stringify({ request: normalized, routeFingerprint, indexVersion }))
      .digest('hex');

    if (this.cacheEnabled) {
      const exact = this.multiFileCache.get(key);
      if (exact && exact.expiresAt > Date.now()) {
        this.exactHits += 1;
        this.multiFileCache.delete(key);
        this.multiFileCache.set(key, exact);
        return this.serveMultiFile(exact.response, 'exact', Date.now() - startedAt);
      }
    }

    const running = this.multiFileInFlight.get(key);
    if (running) {
      this.inFlightJoins += 1;
      const response = await running;
      return this.serveMultiFile(response, 'in-flight', Date.now() - startedAt);
    }

    this.misses += 1;
    const generated = this.multiFilePredictor(normalized, this.index);
    this.multiFileInFlight.set(key, generated);
    try {
      const response = await generated;
      this.recordGeneration(response);
      if (this.cacheEnabled) {
        const ttl = response.edits.length > 0 ? this.cacheTtlMs : NEGATIVE_CACHE_TTL_MS;
        this.multiFileCache.set(key, {
          key,
          response,
          expiresAt: Date.now() + ttl,
        });
        while (this.cache.size + this.multiFileCache.size > this.maxCacheEntries) {
          const oldestMulti = this.multiFileCache.keys().next().value;
          if (oldestMulti) this.multiFileCache.delete(oldestMulti);
          else {
            const oldest = this.cache.keys().next().value;
            if (!oldest) break;
            this.cache.delete(oldest);
          }
        }
      }
      return this.serveMultiFile(response, 'miss', Date.now() - startedAt);
    } finally {
      this.multiFileInFlight.delete(key);
    }
  }

  recordFeedback(feedback: EditPredictionFeedback): EditPredictionFeedbackResult {
    this.cleanup();
    const predictionId = String(feedback.predictionId ?? '').trim();
    if (this.recordedFeedback.has(predictionId)) {
      return { recorded: false, reason: 'already-recorded' };
    }
    const pending = this.pendingFeedback.get(predictionId);
    if (!pending) return { recorded: false, reason: 'unknown-or-expired' };
    const state = this.models.get(pending.modelKey);
    if (!state) return { recorded: false, reason: 'unknown-or-expired' };
    if (feedback.outcome === 'accepted') state.accepted += 1;
    else state.rejected += 1;
    this.pendingFeedback.delete(predictionId);
    this.recordedFeedback.set(predictionId, Date.now());
    this.schedulePersist();
    return { recorded: true };
  }

  report(): EditPredictionEvaluationReport {
    const models = [...this.models.values()]
      .map(evaluateModel)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.feedbackSamples - left.feedbackSamples ||
          left.model.localeCompare(right.model),
      );
    const cacheHits = this.exactHits + this.continuationHits + this.inFlightJoins;
    const totals = models.reduce(
      (result, model) => ({
        generations: result.generations + model.generations,
        validSuggestions: result.validSuggestions + model.validSuggestions,
        suggestionsServed: result.suggestionsServed + model.suggestionsServed,
        feedbackSamples: result.feedbackSamples + model.feedbackSamples,
      }),
      { generations: 0, validSuggestions: 0, suggestionsServed: 0, feedbackSamples: 0 },
    );
    const recommended = models[0];
    return {
      measuredAt: this.now().toISOString(),
      privacy:
        'Aggregate counters and latency only. Hawk never persists prompts, source, diagnostics, file names, or generated edits in this scorecard.',
      cache: {
        enabled: this.cacheEnabled,
        entries: this.cache.size + this.multiFileCache.size,
        maxEntries: this.maxCacheEntries,
        ttlMs: this.cacheTtlMs,
        requests: this.cacheRequests,
        exactHits: this.exactHits,
        continuationHits: this.continuationHits,
        inFlightJoins: this.inFlightJoins,
        misses: this.misses,
        hitRate: ratio(cacheHits, this.cacheRequests),
      },
      totals,
      ...(recommended
        ? {
            recommended: {
              provider: recommended.provider,
              model: recommended.model,
              score: recommended.score,
              confidence: recommended.confidence,
            },
          }
        : {}),
      models,
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.multiFileCache.clear();
    this.multiFileInFlight.clear();
  }

  async dispose(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.queuePersist().catch(() => undefined);
    await this.persistQueue.catch(() => undefined);
  }

  private findContinuation(
    request: NormalizedRequest,
    routeFingerprint: string,
    indexVersion: string,
  ): CacheEntry | undefined {
    const entries = [...this.cache.values()].reverse();
    for (const entry of entries) {
      if (
        entry.expiresAt <= Date.now() ||
        entry.routeFingerprint !== routeFingerprint ||
        entry.indexVersion !== indexVersion ||
        entry.request.file !== request.file ||
        entry.request.languageId !== request.languageId ||
        entry.request.suffix !== request.suffix ||
        entry.response.replaceText !== '' ||
        !entry.response.text ||
        request.prefix.length <= entry.request.prefix.length ||
        !request.prefix.startsWith(entry.request.prefix) ||
        predictionContextKey(entry.request) !== predictionContextKey(request)
      ) {
        continue;
      }
      const typed = request.prefix.slice(entry.request.prefix.length);
      if (typed.length > 128 || !entry.response.text.startsWith(typed)) continue;
      const remaining = entry.response.text.slice(typed.length);
      if (!remaining) continue;
      return {
        ...entry,
        response: { ...entry.response, text: remaining, latencyMs: 0 },
      };
    }
    return undefined;
  }

  private serve(
    response: EditPredictionResponse,
    cacheKind: EditPredictionCacheKind,
    latencyMs: number,
  ): ManagedEditPredictionResponse {
    const predictionId = randomUUID();
    const key =
      response.provider && response.model ? modelKey(response.provider, response.model) : undefined;
    if (key && response.text) {
      const state = this.models.get(key);
      if (state) {
        state.suggestionsServed += 1;
        if (cacheKind === 'exact' || cacheKind === 'continuation') state.cacheServed += 1;
        if (cacheKind === 'in-flight') state.inFlightServed += 1;
        this.pendingFeedback.set(predictionId, { modelKey: key, createdAt: Date.now() });
        while (this.pendingFeedback.size > MAX_PENDING_FEEDBACK) {
          const oldest = this.pendingFeedback.keys().next().value;
          if (!oldest) break;
          this.pendingFeedback.delete(oldest);
        }
        this.schedulePersist();
      }
    }
    return {
      ...response,
      predictionId,
      cached: cacheKind === 'exact' || cacheKind === 'continuation',
      cacheKind,
      latencyMs,
    };
  }

  private serveMultiFile(
    response: MultiFileEditPredictionResponse,
    cacheKind: 'miss' | 'exact' | 'in-flight',
    latencyMs: number,
  ): ManagedMultiFileEditPredictionResponse {
    const predictionId = randomUUID();
    const key =
      response.provider && response.model ? modelKey(response.provider, response.model) : undefined;
    if (key && response.edits.length > 0) {
      const state = this.models.get(key);
      if (state) {
        state.suggestionsServed += 1;
        if (cacheKind === 'exact') state.cacheServed += 1;
        if (cacheKind === 'in-flight') state.inFlightServed += 1;
        this.pendingFeedback.set(predictionId, { modelKey: key, createdAt: Date.now() });
        while (this.pendingFeedback.size > MAX_PENDING_FEEDBACK) {
          const oldest = this.pendingFeedback.keys().next().value;
          if (!oldest) break;
          this.pendingFeedback.delete(oldest);
        }
        this.schedulePersist();
      }
    }
    return {
      ...response,
      predictionId,
      cached: cacheKind === 'exact',
      cacheKind,
      latencyMs,
    };
  }

  private recordGeneration(
    response: EditPredictionResponse | MultiFileEditPredictionResponse,
  ): void {
    if (!response.provider || !response.model) return;
    const key = modelKey(response.provider, response.model);
    const state =
      this.models.get(key) ??
      ({
        provider: response.provider,
        model: response.model,
        generations: 0,
        validSuggestions: 0,
        suggestionsServed: 0,
        cacheServed: 0,
        inFlightServed: 0,
        accepted: 0,
        rejected: 0,
        latencies: [],
      } satisfies ModelState);
    state.generations += 1;
    if ('edits' in response ? response.edits.length > 0 : Boolean(response.text)) {
      state.validSuggestions += 1;
    }
    state.latencies.push(Math.max(0, response.latencyMs));
    if (state.latencies.length > MAX_LATENCY_SAMPLES) {
      state.latencies.splice(0, state.latencies.length - MAX_LATENCY_SAMPLES);
    }
    this.models.set(key, state);
    this.schedulePersist();
  }

  private putCache(entry: CacheEntry): void {
    this.cache.delete(entry.key);
    this.cache.set(entry.key, entry);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private touch(entry: CacheEntry): void {
    this.cache.delete(entry.key);
    this.cache.set(entry.key, entry);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    for (const [key, entry] of this.multiFileCache) {
      if (entry.expiresAt <= now) this.multiFileCache.delete(key);
    }
    for (const [id, pending] of this.pendingFeedback) {
      if (now - pending.createdAt > PENDING_FEEDBACK_TTL_MS) this.pendingFeedback.delete(id);
    }
    for (const [id, recordedAt] of this.recordedFeedback) {
      if (now - recordedAt > PENDING_FEEDBACK_TTL_MS) this.recordedFeedback.delete(id);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.queuePersist().catch(() => undefined);
    }, 1_000);
    this.persistTimer.unref?.();
  }

  private async queuePersist(): Promise<void> {
    const snapshot: StoredScorecard = {
      schema: SCORECARD_SCHEMA,
      models: [...this.models.values()].map((state) => ({
        ...state,
        latencies: state.latencies.slice(-MAX_LATENCY_SAMPLES),
      })),
    };
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.scorecardPath), { recursive: true, mode: 0o700 });
        const temporary = `${this.scorecardPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporary, this.scorecardPath);
      });
    await this.persistQueue;
  }
}

function normalizeRequest(request: EditPredictionRequest): NormalizedRequest {
  return {
    file: String(request.file ?? '').slice(0, 1_000),
    languageId: String(request.languageId ?? 'plaintext').slice(0, 80),
    prefix: String(request.prefix ?? '').slice(-12_000),
    suffix: String(request.suffix ?? '').slice(0, 12_000),
    recentEdits: (request.recentEdits ?? []).slice(-6).map((edit) => ({
      file: String(edit.file ?? '').slice(0, 1_000),
      before: String(edit.before ?? '').slice(0, 1_500),
      after: String(edit.after ?? '').slice(0, 1_500),
      line: Number.isFinite(edit.line) ? Math.max(1, Math.floor(edit.line)) : 1,
    })),
    diagnostics: (request.diagnostics ?? [])
      .slice(0, 20)
      .map((diagnostic) => String(diagnostic).slice(0, 600)),
    minConfidence: clamp(Number(request.minConfidence), 0.3, 0.95, 0.55),
  };
}

function normalizeMultiFileRequest(
  request: MultiFileEditPredictionRequest,
): MultiFileEditPredictionRequest {
  return {
    activeFile: String(request.activeFile ?? '').slice(0, 1_000),
    documents: (request.documents ?? []).slice(0, 8).map((document) => ({
      file: String(document.file ?? '').slice(0, 1_000),
      languageId: String(document.languageId ?? 'plaintext').slice(0, 80),
      content: String(document.content ?? '').slice(0, 80_000),
    })),
    recentEdits: (request.recentEdits ?? []).slice(-8).map((edit) => ({
      file: String(edit.file ?? '').slice(0, 1_000),
      before: String(edit.before ?? '').slice(0, 1_500),
      after: String(edit.after ?? '').slice(0, 1_500),
      line: Number.isFinite(edit.line) ? Math.max(1, Math.floor(edit.line)) : 1,
    })),
    diagnostics: (request.diagnostics ?? [])
      .slice(0, 40)
      .map((diagnostic) => String(diagnostic).slice(0, 600)),
    minConfidence: clamp(Number(request.minConfidence), 0.3, 0.95, 0.55),
  };
}

function predictionKey(
  request: NormalizedRequest,
  routeFingerprint: string,
  indexVersion: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ request, routeFingerprint, indexVersion }))
    .digest('hex');
}

function predictionContextKey(request: NormalizedRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        recentEdits: request.recentEdits,
        diagnostics: request.diagnostics,
        minConfidence: request.minConfidence,
      }),
    )
    .digest('hex');
}

function configuredRouteFingerprint(): string {
  try {
    const cfg = config.load();
    return createHash('sha256')
      .update(
        JSON.stringify({
          backend: process.env.HAWK_IDE_BACKEND || cfg.backend,
          model: process.env.HAWK_IDE_MODEL || cfg.model,
          baseUrl: process.env.HAWK_IDE_BASE_URL || cfg.base_url,
          fallbacks: cfg.fallback_models
            .filter((route) => route.purpose === 'fast' || route.purpose === 'general')
            .map((route) => ({
              backend: route.backend,
              model: route.model,
              baseUrl: route.base_url,
              purpose: route.purpose,
            })),
        }),
      )
      .digest('hex');
  } catch {
    return createHash('sha256')
      .update(
        [
          process.env.HAWK_IDE_BACKEND ?? '',
          process.env.HAWK_IDE_MODEL ?? '',
          process.env.HAWK_IDE_BASE_URL ?? '',
        ].join('\n'),
      )
      .digest('hex');
  }
}

function normalizeModelState(candidate: ModelState): ModelState | undefined {
  if (
    !candidate ||
    typeof candidate.provider !== 'string' ||
    typeof candidate.model !== 'string' ||
    !candidate.provider ||
    !candidate.model
  ) {
    return undefined;
  }
  return {
    provider: candidate.provider.slice(0, 300),
    model: candidate.model.slice(0, 300),
    generations: count(candidate.generations),
    validSuggestions: count(candidate.validSuggestions),
    suggestionsServed: count(candidate.suggestionsServed),
    cacheServed: count(candidate.cacheServed),
    inFlightServed: count(candidate.inFlightServed),
    accepted: count(candidate.accepted),
    rejected: count(candidate.rejected),
    latencies: Array.isArray(candidate.latencies)
      ? candidate.latencies
          .filter((latency) => Number.isFinite(latency) && latency >= 0)
          .slice(-MAX_LATENCY_SAMPLES)
      : [],
  };
}

function evaluateModel(state: ModelState): EditPredictionModelEvaluation {
  const feedbackSamples = state.accepted + state.rejected;
  const acceptanceRate = feedbackSamples > 0 ? ratio(state.accepted, feedbackSamples) : undefined;
  const validRate = ratio(state.validSuggestions, state.generations);
  const p50GenerationMs = percentile(state.latencies, 0.5);
  const p95GenerationMs = percentile(state.latencies, 0.95);
  const speedScore =
    p95GenerationMs === undefined ? 0 : Math.max(0, Math.min(1, 1 - p95GenerationMs / 12_000));
  const qualityProxy = acceptanceRate ?? validRate * 0.5;
  const score = round((qualityProxy * 0.55 + validRate * 0.2 + speedScore * 0.25) * 100);
  const confidence: EditPredictionModelEvaluation['confidence'] =
    feedbackSamples >= 50 ? 'high' : feedbackSamples >= 10 ? 'medium' : 'low';
  return {
    provider: state.provider,
    model: state.model,
    generations: state.generations,
    validSuggestions: state.validSuggestions,
    suggestionsServed: state.suggestionsServed,
    cacheServed: state.cacheServed,
    inFlightServed: state.inFlightServed,
    accepted: state.accepted,
    rejected: state.rejected,
    feedbackSamples,
    feedbackCoverage: ratio(feedbackSamples, state.suggestionsServed),
    validRate,
    ...(acceptanceRate === undefined ? {} : { acceptanceRate }),
    ...(p50GenerationMs === undefined ? {} : { p50GenerationMs }),
    ...(p95GenerationMs === undefined ? {} : { p95GenerationMs }),
    score,
    confidence,
  };
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index] ?? 0);
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.floor(clamp(value, minimum, maximum, fallback));
}
