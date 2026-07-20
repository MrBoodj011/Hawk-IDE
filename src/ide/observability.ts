import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { info } from '../logger/logger.js';

const MAX_TRACES = 500;
const MAX_ROUTES = 200;
const MAX_EXTRA_BYTES = 256 * 1024;

export interface RequestTraceStart {
  id: string;
  method: string;
  route: string;
  startedAt: string;
  startedNs: bigint;
}

export interface RequestTrace {
  id: string;
  method: string;
  route: string;
  status: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface RouteMetric {
  method: string;
  route: string;
  requests: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ObservabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  uptimeSeconds: number;
  totals: {
    requests: number;
    errors: number;
    active: number;
    status2xx: number;
    status4xx: number;
    status5xx: number;
  };
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  routes: RouteMetric[];
  recentTraces: RequestTrace[];
}

export interface DebugBundleResult {
  schemaVersion: 1;
  generatedAt: string;
  path: string;
  manifestPath: string;
  sha256: string;
  bytes: number;
}

interface RouteAccumulator {
  method: string;
  route: string;
  requests: number;
  errors: number;
  durations: number[];
}

export class HawkObservability {
  private readonly startedAt = Date.now();
  private readonly traces: RequestTrace[] = [];
  private readonly routes = new Map<string, RouteAccumulator>();
  private active = 0;
  private requests = 0;
  private errors = 0;
  private status2xx = 0;
  private status4xx = 0;
  private status5xx = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  start(method: string | undefined, rawUrl: string | undefined): RequestTraceStart {
    this.active += 1;
    return {
      id: `trace-${randomUUID()}`,
      method: normalizeMethod(method),
      route: normalizeRoute(rawUrl),
      startedAt: this.now().toISOString(),
      startedNs: process.hrtime.bigint(),
    };
  }

  finish(start: RequestTraceStart, status: number): RequestTrace {
    this.active = Math.max(0, this.active - 1);
    this.requests += 1;
    if (status >= 500) {
      this.errors += 1;
      this.status5xx += 1;
    } else if (status >= 400) {
      this.status4xx += 1;
    } else if (status >= 200) {
      this.status2xx += 1;
    }
    const durationMs = Number(process.hrtime.bigint() - start.startedNs) / 1_000_000;
    const trace: RequestTrace = {
      id: start.id,
      method: start.method,
      route: start.route,
      status,
      startedAt: start.startedAt,
      completedAt: this.now().toISOString(),
      durationMs: round(durationMs),
    };
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) this.traces.splice(0, this.traces.length - MAX_TRACES);

    const key = `${trace.method} ${trace.route}`;
    let accumulator = this.routes.get(key);
    if (!accumulator) {
      if (this.routes.size >= MAX_ROUTES) {
        const oldest = this.routes.keys().next().value;
        if (oldest) this.routes.delete(oldest);
      }
      accumulator = {
        method: trace.method,
        route: trace.route,
        requests: 0,
        errors: 0,
        durations: [],
      };
      this.routes.set(key, accumulator);
    }
    accumulator.requests += 1;
    if (status >= 500) accumulator.errors += 1;
    accumulator.durations.push(durationMs);
    if (accumulator.durations.length > 256) accumulator.durations.shift();
    info('ide_request_completed', {
      trace_id: trace.id,
      method: trace.method,
      route: trace.route,
      status,
      duration_ms: trace.durationMs,
    });
    return trace;
  }

  snapshot(): ObservabilitySnapshot {
    const memory = process.memoryUsage();
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      uptimeSeconds: round((Date.now() - this.startedAt) / 1_000),
      totals: {
        requests: this.requests,
        errors: this.errors,
        active: this.active,
        status2xx: this.status2xx,
        status4xx: this.status4xx,
        status5xx: this.status5xx,
      },
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      routes: [...this.routes.values()]
        .map((value) => metric(value))
        .sort(
          (left, right) => right.requests - left.requests || left.route.localeCompare(right.route),
        ),
      recentTraces: this.traces.slice(-100).map((trace) => ({ ...trace })),
    };
  }

  async buildDebugBundle(input: {
    approved: boolean;
    workspaceRoot: string;
    extra?: Record<string, unknown>;
  }): Promise<DebugBundleResult> {
    if (input.approved !== true)
      throw new Error('Operator approval is required for a debug bundle');
    const workspaceRoot = resolve(input.workspaceRoot);
    const hawkRoot = join(workspaceRoot, '.hawk');
    const outputRoot = join(hawkRoot, 'diagnostics');
    await rejectSymlink(hawkRoot);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await rejectSymlink(outputRoot);

    const generatedAt = this.now().toISOString();
    const stamp = generatedAt.replace(/[:.]/g, '-');
    const path = join(outputRoot, `hawk-debug-bundle-${stamp}.json`);
    const manifestPath = join(outputRoot, `hawk-debug-bundle-${stamp}.manifest.json`);
    const extra = boundedExtra(input.extra);
    const payload = {
      schemaVersion: 1,
      generatedAt,
      workspaceId: createHash('sha256')
        .update(workspaceRoot.toLowerCase())
        .digest('hex')
        .slice(0, 20),
      runtime: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
      },
      observability: this.snapshot(),
      ...(extra ? { extra } : {}),
      privacy:
        'No source code, request bodies, response bodies, credentials, tokens, prompts, or absolute workspace path are included.',
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const sha256 = createHash('sha256').update(serialized).digest('hex');
    await writeFileAtomic(path, serialized, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      file: path.split(/[\\/]/).at(-1),
      bytes: Buffer.byteLength(serialized),
      sha256,
    };
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
    return {
      schemaVersion: 1,
      generatedAt,
      path,
      manifestPath,
      sha256,
      bytes: Buffer.byteLength(serialized),
    };
  }
}

function metric(value: RouteAccumulator): RouteMetric {
  const sorted = [...value.durations].sort((left, right) => left - right);
  return {
    method: value.method,
    route: value.route,
    requests: value.requests,
    errors: value.errors,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function normalizeMethod(value: string | undefined): string {
  const method = String(value ?? 'UNKNOWN').toUpperCase();
  return /^[A-Z]{1,16}$/.test(method) ? method : 'UNKNOWN';
}

function normalizeRoute(rawUrl: string | undefined): string {
  let pathname = '/';
  try {
    pathname = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/invalid-url';
  }
  const normalized = pathname
    .split('/')
    .map((segment) => {
      if (/^[0-9]+$/.test(segment)) return ':number';
      if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(segment)) return ':id';
      if (segment.length > 120) return ':value';
      return segment;
    })
    .join('/');
  return normalized.slice(0, 512) || '/';
}

function boundedExtra(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_EXTRA_BYTES) {
    throw new Error('Debug bundle metadata exceeds the 256 KiB limit');
  }
  if (/(?:token|secret|password|authorization|cookie|api[_-]?key)/i.test(serialized)) {
    throw new Error('Debug bundle metadata contains a secret-shaped field');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error('Hawk diagnostics path may not be a symbolic link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
