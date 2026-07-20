import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { CapturedHeader, CapturedRequest } from '../browser/store.js';
import {
  IDE_PROTOCOL_VERSION,
  type IdentityReplayCredentialInput,
  type IdentityReplayObservation,
  type IdentityReplayPlan,
  type IdentityReplayResult,
} from './protocol.js';

const PLAN_TTL_MS = 10 * 60 * 1_000;
const MAX_IDENTITIES = 8;
const MAX_HEADERS_PER_IDENTITY = 24;
const MAX_BODY_BYTES = 64 * 1_024;
const MAX_RESPONSE_PREFIX_BYTES = 128 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CREDENTIAL_HEADERS =
  /^(?:authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export interface IdentityReplayPlanInput {
  requestId: string;
  allowedHost: string;
  identities: IdentityReplayCredentialInput[];
  maxRequestsPerSecond?: number;
}

export interface IdentityReplayExecuteInput {
  planId: string;
  approvalHash: string;
  approved: boolean;
}

interface InternalPlan {
  plan: IdentityReplayPlan;
  request: CapturedRequest;
  identities: IdentityReplayCredentialInput[];
}

export class IdentityReplayService {
  private readonly plans = new Map<string, InternalPlan>();
  private readonly approvalKey = randomBytes(32);

  constructor(
    private readonly getRequest: (id: string) => CapturedRequest | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  createPlan(input: IdentityReplayPlanInput): IdentityReplayPlan {
    this.prune();
    const request = this.getRequest(input.requestId);
    if (!request) throw new Error('Captured request was not found or has expired');
    const url = replayURL(request.url);
    const allowedHost = normalizeAuthority(input.allowedHost);
    if (!allowedHost || url.host.toLowerCase() !== allowedHost) {
      throw new Error('allowedHost must exactly match the captured request host and port');
    }
    if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      throw new Error(`Captured method ${request.method} is not supported for governed replay`);
    }
    const identities = validateIdentities(input.identities);
    const maxRequestsPerSecond = input.maxRequestsPerSecond ?? 2;
    if (
      !Number.isFinite(maxRequestsPerSecond) ||
      maxRequestsPerSecond < 0.1 ||
      maxRequestsPerSecond > 5
    ) {
      throw new Error('maxRequestsPerSecond must be between 0.1 and 5');
    }
    const createdAt = this.now();
    const id = `replay-plan-${randomUUID()}`;
    const credentialBinding = createHmac('sha256', this.approvalKey)
      .update(
        JSON.stringify(
          identities.map((identity) => ({
            id: identity.id,
            headers: Object.entries(identity.headers).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          })),
        ),
      )
      .digest('hex');
    const publicPlan = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      request: {
        id: request.id,
        method: request.method,
        url: sanitizeReplayURL(url),
        host: url.host,
      },
      identities: identities.map((identity) => ({
        id: identity.id,
        label: identity.label,
        headerNames: Object.keys(identity.headers).sort((left, right) => left.localeCompare(right)),
      })),
      rateLimit: {
        maxRequests: identities.length,
        maxRequestsPerSecond,
      },
      statement:
        'Hawk will replay one captured request once per named identity, only to the exact captured host, without redirects. Credentials and response bodies remain memory-only. Different responses are evidence leads, never an automatic authorization finding.',
    };
    const approvalHash = createHash('sha256')
      .update(JSON.stringify(publicPlan))
      .update('\u0000')
      .update(credentialBinding)
      .digest('hex');
    const plan: IdentityReplayPlan = { ...publicPlan, approvalHash };
    this.plans.set(id, {
      plan,
      request: structuredClone(request),
      identities: structuredClone(identities),
    });
    while (this.plans.size > 20) {
      const oldest = this.plans.keys().next().value;
      if (!oldest) break;
      this.plans.delete(oldest);
    }
    return structuredClone(plan);
  }

  async execute(input: IdentityReplayExecuteInput): Promise<IdentityReplayResult> {
    this.prune();
    if (input.approved !== true) throw new Error('Explicit operator approval is required');
    const internal = this.plans.get(input.planId);
    if (!internal) throw new Error('Replay plan was not found or has expired');
    if (input.approvalHash !== internal.plan.approvalHash)
      throw new Error('Replay approval hash does not match the exact plan');
    this.plans.delete(input.planId);

    const startedAt = this.now();
    const observations: IdentityReplayObservation[] = [];
    const delayMs = Math.ceil(1_000 / internal.plan.rateLimit.maxRequestsPerSecond);
    for (const [index, identity] of internal.identities.entries()) {
      if (index > 0) await delay(delayMs);
      observations.push(await this.replay(internal.request, identity));
    }
    const baseline = observations[0];
    const baselineFingerprint = baseline ? observationFingerprint(baseline) : '';
    for (const observation of observations) {
      observation.matchesBaseline =
        Boolean(baselineFingerprint) && observationFingerprint(observation) === baselineFingerprint;
    }
    return {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `replay-${randomUUID()}`,
      planId: internal.plan.id,
      requestId: internal.request.id,
      host: internal.plan.request.host,
      startedAt: startedAt.toISOString(),
      completedAt: this.now().toISOString(),
      observations,
      statement:
        'Response differences are bounded replay observations. Validate object ownership, role, side effects, scope, and impact manually before creating a finding.',
    };
  }

  private async replay(
    request: CapturedRequest,
    identity: IdentityReplayCredentialInput,
  ): Promise<IdentityReplayObservation> {
    const started = Date.now();
    try {
      const url = replayURL(request.url);
      const headers = replayHeaders(request.requestHeaders, identity.headers);
      const body = replayBody(request.requestBody);
      if (body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
        headers.set('Content-Length', String(Buffer.byteLength(body)));
      }
      const response = await this.fetcher(url, {
        method: request.method,
        headers,
        ...(body !== undefined && request.method !== 'GET' && request.method !== 'HEAD'
          ? { body }
          : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const observed = await observeResponse(response);
      return {
        identityId: identity.id,
        label: identity.label,
        status: response.status,
        elapsedMs: Date.now() - started,
        contentType: response.headers.get('content-type')?.slice(0, 160) || undefined,
        location: sanitizeLocation(response.headers.get('location')),
        ...observed,
      };
    } catch (error) {
      return {
        identityId: identity.id,
        label: identity.label,
        elapsedMs: Date.now() - started,
        bodyBytesObserved: 0,
        truncated: false,
        error: safeError(error),
      };
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, value] of this.plans) {
      if (Date.parse(value.plan.expiresAt) <= now) this.plans.delete(id);
    }
  }
}

function validateIdentities(
  identities: IdentityReplayCredentialInput[],
): IdentityReplayCredentialInput[] {
  if (!Array.isArray(identities) || identities.length < 2 || identities.length > MAX_IDENTITIES) {
    throw new Error(`Replay requires 2-${MAX_IDENTITIES} distinct identities`);
  }
  const ids = new Set<string>();
  return identities.map((identity) => {
    const id = String(identity?.id ?? '').trim();
    const label = String(identity?.label ?? '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || ids.has(id)) {
      throw new Error('Every replay identity needs a unique safe id');
    }
    ids.add(id);
    if (!label || label.length > 120) throw new Error(`Identity ${id} needs a short label`);
    const entries = Object.entries(identity.headers ?? {});
    if (entries.length === 0 || entries.length > MAX_HEADERS_PER_IDENTITY) {
      throw new Error(`Identity ${id} needs 1-${MAX_HEADERS_PER_IDENTITY} credential headers`);
    }
    const headers: Record<string, string> = {};
    let hasCredential = false;
    for (const [rawName, rawValue] of entries) {
      const name = rawName.trim();
      const lower = name.toLowerCase();
      const value = String(rawValue);
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || FORBIDDEN_HEADERS.has(lower)) {
        throw new Error(`Identity ${id} contains a forbidden header name`);
      }
      if (!value || value.length > 8_192 || /[\r\n]/.test(value)) {
        throw new Error(`Identity ${id} contains an invalid header value`);
      }
      if (CREDENTIAL_HEADERS.test(name)) hasCredential = true;
      headers[name] = value;
    }
    if (!hasCredential) {
      throw new Error(
        `Identity ${id} needs Authorization, Cookie, X-API-Key, X-Auth-Token, or CSRF token material`,
      );
    }
    return { id, label, headers };
  });
}

function replayHeaders(
  captured: CapturedHeader[] | undefined,
  identity: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const item of captured ?? []) {
    const name = item.name.trim();
    const lower = name.toLowerCase();
    if (
      !name ||
      FORBIDDEN_HEADERS.has(lower) ||
      CREDENTIAL_HEADERS.test(name) ||
      /[\r\n]/.test(item.value)
    ) {
      continue;
    }
    headers.set(name, item.value);
  }
  for (const [name, value] of Object.entries(identity)) headers.set(name, value);
  return headers;
}

function replayBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let body: string;
  if (typeof value === 'string') body = value;
  else if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === 'raw' && typeof record.data === 'string') body = record.data;
    else if (record.type === 'form' && record.data && typeof record.data === 'object') {
      body = new URLSearchParams(
        Object.entries(record.data as Record<string, unknown>).map(
          ([key, item]): [string, string] => [key, String(item)],
        ),
      ).toString();
    } else body = JSON.stringify(value);
  } else body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new Error('Captured request body exceeds the 64 KiB governed replay limit');
  }
  return body;
}

async function observeResponse(response: Response): Promise<{
  bodyBytesObserved: number;
  bodyPrefixSha256?: string;
  truncated: boolean;
}> {
  if (!response.body) return { bodyBytesObserved: 0, truncated: false };
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      const remaining = MAX_RESPONSE_PREFIX_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const accepted = chunk.subarray(0, remaining);
      hash.update(accepted);
      bytes += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return {
    bodyBytesObserved: bytes,
    ...(bytes > 0 ? { bodyPrefixSha256: hash.digest('hex') } : {}),
    truncated,
  };
}

function replayURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Governed replay supports only HTTP and HTTPS');
  }
  if (url.username || url.password) throw new Error('Captured URL must not contain credentials');
  return url;
}

function normalizeAuthority(value: string): string {
  try {
    return new URL(`http://${value}`).host.toLowerCase();
  } catch {
    return '';
  }
}

function sanitizeReplayURL(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function sanitizeLocation(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split('?')[0]?.slice(0, 512);
  }
}

function observationFingerprint(value: IdentityReplayObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        status: value.status ?? 0,
        contentType: value.contentType ?? '',
        location: value.location ?? '',
        bytes: value.bodyBytesObserved,
        prefix: value.bodyPrefixSha256 ?? '',
        error: value.error ?? '',
      }),
    )
    .digest('hex');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/gi, '[approved target]').slice(0, 300);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
