import { createHash } from 'node:crypto';
import type { CapturedRequest } from '../browser/store.js';
import { IDE_PROTOCOL_VERSION, type TrafficInventory, type TrafficRequest } from './protocol.js';

const MAX_HAR_ENTRIES = 1_500;
const MAX_LIVE_ENTRIES = 1_500;
const SENSITIVE_PARAMETER =
  /(?:api[_-]?key|auth(?:orization)?|cookie|pass(?:word)?|secret|session|token)/i;

/**
 * Converts a user-selected HAR export into a small, redacted local inventory.
 * The IDE never replays these requests and intentionally does not retain
 * request/response bodies, cookies, or authorization values.
 */
export function importHarTraffic(value: unknown, now = new Date()): TrafficInventory {
  const entries = harEntries(value);
  const requests: TrafficRequest[] = [];
  let truncated = false;

  for (const [index, entry] of entries.entries()) {
    if (requests.length >= MAX_HAR_ENTRIES) {
      truncated = true;
      break;
    }
    const parsed = parseHarEntry(entry, index, now);
    if (parsed) requests.push(parsed);
  }

  const hosts = [...new Set(requests.map((request) => request.host))].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    importedAt: now.toISOString(),
    source: 'har',
    hosts,
    requests,
    truncated,
    live: false,
  };
}

/**
 * Converts the bounded capture bridge store into the same redacted inventory
 * used by the IDE. Bodies and headers deliberately remain in the bridge store;
 * the workbench receives only request metadata needed for its live timeline and
 * source correlation graph.
 */
export function importLiveTraffic(entries: CapturedRequest[], now = new Date()): TrafficInventory {
  const requests: TrafficRequest[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (requests.length >= MAX_LIVE_ENTRIES) {
      truncated = true;
      break;
    }
    const parsed = parseCapturedRequest(entry);
    if (parsed) requests.push(parsed);
  }
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    importedAt: now.toISOString(),
    source: 'live',
    hosts: uniqueHosts(requests),
    requests,
    truncated,
    live: true,
  };
}

export function mergeTrafficInventories(
  imported: TrafficInventory | null,
  live: TrafficInventory,
  now = new Date(),
): TrafficInventory | null {
  if (!imported && live.requests.length === 0) return null;
  if (!imported) return live;
  if (live.requests.length === 0) return imported;

  const deduped = new Map<string, TrafficRequest>();
  for (const request of [...imported.requests, ...live.requests]) {
    deduped.set(request.id, request);
  }
  const requests = [...deduped.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, MAX_HAR_ENTRIES + MAX_LIVE_ENTRIES);
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    importedAt: now.toISOString(),
    source: 'mixed',
    hosts: uniqueHosts(requests),
    requests,
    truncated:
      imported.truncated || live.truncated || deduped.size > MAX_HAR_ENTRIES + MAX_LIVE_ENTRIES,
    live: true,
  };
}

function harEntries(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') throw new Error('HAR must be a JSON object');
  const log = (value as Record<string, unknown>).log;
  if (!log || typeof log !== 'object') throw new Error('HAR is missing its log object');
  const entries = (log as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) throw new Error('HAR is missing log.entries');
  return entries;
}

function parseHarEntry(value: unknown, index: number, now: Date): TrafficRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const request = entry.request;
  if (!request || typeof request !== 'object') return undefined;
  const method = (request as Record<string, unknown>).method;
  const rawURL = (request as Record<string, unknown>).url;
  if (typeof method !== 'string' || typeof rawURL !== 'string') return undefined;

  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const response = entry.response;
  const rawStatus =
    response && typeof response === 'object'
      ? (response as Record<string, unknown>).status
      : undefined;
  const startedAt =
    typeof entry.startedDateTime === 'string' ? entry.startedDateTime : now.toISOString();
  const sanitizedURL = sanitizeURL(url);
  return {
    id: `har-${createHash('sha256')
      .update(`${index}\u0000${method}\u0000${sanitizedURL}\u0000${startedAt}`)
      .digest('hex')
      .slice(0, 16)}`,
    method: method.toUpperCase(),
    url: sanitizedURL,
    host: url.host,
    ...(typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? { status: rawStatus } : {}),
    startedAt,
    source: 'har',
  };
}

function parseCapturedRequest(entry: CapturedRequest): TrafficRequest | undefined {
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const receivedAt = new Date(entry.receivedAt);
  const startedAt = new Date(entry.timeStart ?? entry.receivedAt);
  const completedAt =
    typeof entry.timeEnd === 'number' ? new Date(entry.timeEnd).toISOString() : undefined;
  return {
    id: `live-${createHash('sha256')
      .update(`${entry.id}\u0000${entry.method}\u0000${entry.url}`)
      .digest('hex')
      .slice(0, 16)}`,
    method: entry.method.toUpperCase(),
    url: sanitizeURL(url),
    host: url.host,
    ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
    startedAt: Number.isNaN(startedAt.getTime())
      ? receivedAt.toISOString()
      : startedAt.toISOString(),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof entry.elapsedMs === 'number' ? { elapsedMs: entry.elapsedMs } : {}),
    source: entry.source === 'burp' ? 'burp' : 'browser',
    ...(entry.initiator ? { initiator: sanitizeInitiator(entry.initiator) } : {}),
    ...(entry.type ? { type: entry.type.slice(0, 80) } : {}),
  };
}

function uniqueHosts(requests: TrafficRequest[]): string[] {
  return [...new Set(requests.map((request) => request.host))].sort((a, b) => a.localeCompare(b));
}

function sanitizeInitiator(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.slice(0, 512);
  }
}

export function sanitizeURL(url: URL): string {
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    query.set(key, SENSITIVE_PARAMETER.test(key) ? 'REDACTED' : value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `${url.origin}${url.pathname}${suffix}`;
}
