import { createHash } from 'node:crypto';
import type { CapturedInteraction, CapturedRequest } from '../browser/store.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_INPUT_RECORDS = 5_000;

export type InteractionChaosSeverity = 'high' | 'medium' | 'low';

export interface InteractionChaosSignal {
  id: string;
  ruleId: 'hawk.ui.rapid-interaction' | 'hawk.ui.rapid-submit' | 'hawk.ui.duplicate-mutation';
  severity: InteractionChaosSeverity;
  confidence: 'signal';
  title: string;
  description: string;
  remediation: string;
  pageUrl: string;
  targetFingerprint?: string;
  interactionIds: string[];
  requestIds: string[];
  statuses: number[];
  startedAt: string;
  completedAt: string;
  evidence: string[];
}

export interface InteractionChaosReport {
  protocolVersion: number;
  generatedAt: string;
  mode: 'captured-only';
  config: {
    rapidWindowMs: number;
    requestWindowMs: number;
    minimumBurst: number;
  };
  summary: {
    interactions: number;
    mutationRequests: number;
    rapidInteractionBursts: number;
    duplicateMutationBursts: number;
    highSignals: number;
    mediumSignals: number;
    lowSignals: number;
    signals: number;
  };
  signals: InteractionChaosSignal[];
  statement: string;
}

export interface InteractionChaosOptions {
  rapidWindowMs?: number;
  requestWindowMs?: number;
  minimumBurst?: number;
  now?: Date;
}

/**
 * Correlates captured, trusted UI interactions with already-observed mutation
 * requests. It never clicks a page or sends target traffic itself.
 */
export function analyzeInteractionChaos(
  interactionInput: CapturedInteraction[],
  requestInput: CapturedRequest[],
  options: InteractionChaosOptions = {},
): InteractionChaosReport {
  const rapidWindowMs = boundedInteger(options.rapidWindowMs, 100, 5_000, 750);
  const requestWindowMs = boundedInteger(options.requestWindowMs, 250, 10_000, 2_000);
  const minimumBurst = boundedInteger(options.minimumBurst, 2, 20, 3);
  const interactions = interactionInput
    .filter((event) => event.trusted)
    .slice(-MAX_INPUT_RECORDS)
    .sort((left, right) => left.occurredAt - right.occurredAt);
  const requests = requestInput
    .filter((request) => MUTATION_METHODS.has(request.method.toUpperCase()))
    .slice(-MAX_INPUT_RECORDS)
    .sort((left, right) => requestTime(left) - requestTime(right));
  const signals: InteractionChaosSignal[] = [];
  const correlatedRequestIds = new Set<string>();
  let rapidInteractionBursts = 0;
  let duplicateMutationBursts = 0;

  for (const events of grouped(interactions, interactionKey).values()) {
    for (const burst of contiguous(events, (event) => event.occurredAt, rapidWindowMs)) {
      if (burst.length < minimumBurst) continue;
      rapidInteractionBursts += 1;
      const first = burst[0];
      const last = burst.at(-1);
      if (!first || !last) continue;
      const related = requests.filter((request) => {
        const at = requestTime(request);
        if (at < first.occurredAt - 250 || at > last.occurredAt + requestWindowMs) return false;
        const initiatorPage = request.initiator ? pageUrl(request.initiator) : '';
        return (
          tabsCompatible(first.tabId, request.tabId) &&
          (!initiatorPage || initiatorPage === pageUrl(first.url))
        );
      });
      const duplicateGroups = [...grouped(related, requestKey).values()].filter(
        (group) => group.length >= 2,
      );
      const duplicateRequests = duplicateGroups.flat();
      duplicateRequests.forEach((request) => correlatedRequestIds.add(request.id));
      if (duplicateGroups.length > 0) duplicateMutationBursts += duplicateGroups.length;
      const statuses = uniqueStatuses(duplicateRequests);
      const unstable = statuses.some((status) => status >= 500) || statuses.length > 1;
      const isSubmit =
        first.kind === 'submit' ||
        first.target.inputType === 'submit' ||
        first.target.inputType === 'image';
      const severity: InteractionChaosSeverity = unstable
        ? 'high'
        : duplicateRequests.length > 0 || isSubmit
          ? 'medium'
          : 'low';
      const ruleId = isSubmit
        ? 'hawk.ui.rapid-submit'
        : duplicateRequests.length > 0
          ? 'hawk.ui.duplicate-mutation'
          : 'hawk.ui.rapid-interaction';
      const evidence = [
        `${burst.length} trusted ${first.kind} events hit the same structural target in ${Math.max(0, last.occurredAt - first.occurredAt)} ms.`,
      ];
      if (duplicateRequests.length > 0) {
        evidence.push(
          `${duplicateRequests.length} mutation requests were observed across ${duplicateGroups.length} repeated endpoint group(s).`,
        );
      }
      if (statuses.length > 0) evidence.push(`Observed response statuses: ${statuses.join(', ')}.`);
      signals.push(
        signal({
          ruleId,
          severity,
          title:
            duplicateRequests.length > 0
              ? 'Rapid UI action triggered duplicate mutation requests'
              : isSubmit
                ? 'Submit action accepted a rapid interaction burst'
                : 'Interactive control accepted a rapid click burst',
          description:
            'Captured browser evidence indicates that one structural UI target accepted repeated trusted interactions inside a short window. This can expose missing in-flight guards, duplicate side effects, stale-state races, or inconsistent error handling.',
          remediation:
            'Add a synchronous in-flight guard, disable the control before awaiting work, make the server mutation idempotent, and add a regression test that repeats the interaction under delayed responses.',
          pageUrl: pageUrl(first.url),
          targetFingerprint: first.target.fingerprint,
          interactionIds: burst.map((event) => event.id),
          requestIds: duplicateRequests.map((request) => request.id),
          statuses,
          startedAtMs: first.occurredAt,
          completedAtMs: Math.max(last.occurredAt, ...duplicateRequests.map(requestTime)),
          evidence,
        }),
      );
    }
  }

  for (const requestGroup of grouped(requests, requestKey).values()) {
    for (const burst of contiguous(requestGroup, requestTime, requestWindowMs)) {
      if (burst.length < 2 || burst.every((request) => correlatedRequestIds.has(request.id))) {
        continue;
      }
      duplicateMutationBursts += 1;
      const first = burst[0];
      const last = burst.at(-1);
      if (!first || !last) continue;
      const statuses = uniqueStatuses(burst);
      const unstable = statuses.some((status) => status >= 500) || statuses.length > 1;
      signals.push(
        signal({
          ruleId: 'hawk.ui.duplicate-mutation',
          severity: unstable ? 'high' : 'medium',
          title: 'Duplicate mutation request burst observed',
          description:
            'The same mutation endpoint was called repeatedly inside a short window. No matching captured click burst was required, so this can also reveal programmatic double-submit, retry storms, or duplicated event listeners.',
          remediation:
            'Trace the request initiator, deduplicate event listeners, add an idempotency key, reject duplicate in-flight operations, and verify one durable side effect per user intent.',
          pageUrl: pageUrl(first.initiator ?? first.url),
          interactionIds: [],
          requestIds: burst.map((request) => request.id),
          statuses,
          startedAtMs: requestTime(first),
          completedAtMs: requestTime(last),
          evidence: [
            `${burst.length} ${first.method.toUpperCase()} requests targeted ${endpointUrl(first.url)} within ${Math.max(0, requestTime(last) - requestTime(first))} ms.`,
            ...(statuses.length > 0 ? [`Observed response statuses: ${statuses.join(', ')}.`] : []),
          ],
        }),
      );
    }
  }

  signals.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    mode: 'captured-only',
    config: { rapidWindowMs, requestWindowMs, minimumBurst },
    summary: {
      interactions: interactions.length,
      mutationRequests: requests.length,
      rapidInteractionBursts,
      duplicateMutationBursts,
      highSignals: signals.filter((item) => item.severity === 'high').length,
      mediumSignals: signals.filter((item) => item.severity === 'medium').length,
      lowSignals: signals.filter((item) => item.severity === 'low').length,
      signals: signals.length,
    },
    signals,
    statement:
      'Captured-only interaction analysis. Hawk did not click the page or generate target traffic. Every result is a race-condition signal that requires impact validation.',
  };
}

interface SignalInput {
  ruleId: InteractionChaosSignal['ruleId'];
  severity: InteractionChaosSeverity;
  title: string;
  description: string;
  remediation: string;
  pageUrl: string;
  targetFingerprint?: string;
  interactionIds: string[];
  requestIds: string[];
  statuses: number[];
  startedAtMs: number;
  completedAtMs: number;
  evidence: string[];
}

function signal(input: SignalInput): InteractionChaosSignal {
  const stable = JSON.stringify({
    ruleId: input.ruleId,
    pageUrl: input.pageUrl,
    targetFingerprint: input.targetFingerprint,
    interactionIds: input.interactionIds,
    requestIds: input.requestIds,
  });
  return {
    id: `interaction-${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`,
    ruleId: input.ruleId,
    severity: input.severity,
    confidence: 'signal',
    title: input.title,
    description: input.description,
    remediation: input.remediation,
    pageUrl: input.pageUrl,
    ...(input.targetFingerprint ? { targetFingerprint: input.targetFingerprint } : {}),
    interactionIds: [...new Set(input.interactionIds)].slice(0, 100),
    requestIds: [...new Set(input.requestIds)].slice(0, 100),
    statuses: [...new Set(input.statuses)].slice(0, 32),
    startedAt: validDate(input.startedAtMs).toISOString(),
    completedAt: validDate(Math.max(input.startedAtMs, input.completedAtMs)).toISOString(),
    evidence: input.evidence.map((item) => item.slice(0, 1_000)).slice(0, 20),
  };
}

function grouped<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const values = output.get(id) ?? [];
    values.push(item);
    output.set(id, values);
  }
  return output;
}

function contiguous<T>(items: T[], time: (item: T) => number, maximumGapMs: number): T[][] {
  const output: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    if (previous && time(item) - time(previous) > maximumGapMs) {
      output.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) output.push(current);
  return output;
}

function interactionKey(event: CapturedInteraction): string {
  return [event.tabId ?? 'tab', pageUrl(event.url), event.kind, event.target.fingerprint].join(
    '\u0000',
  );
}

function requestKey(request: CapturedRequest): string {
  return [
    request.tabId ?? 'tab',
    request.method.toUpperCase(),
    requestFingerprintUrl(request.url),
  ].join('\u0000');
}

function requestTime(request: CapturedRequest): number {
  return request.timeStart ?? request.receivedAt;
}

function uniqueStatuses(requests: CapturedRequest[]): number[] {
  return [
    ...new Set(
      requests
        .map((request) => request.status)
        .filter((status): status is number => typeof status === 'number'),
    ),
  ].sort((left, right) => left - right);
}

function tabsCompatible(
  interactionTab: number | undefined,
  requestTab: number | undefined,
): boolean {
  return interactionTab === undefined || requestTab === undefined || interactionTab === requestTab;
}

function pageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0]?.slice(0, 2_000) ?? '';
  }
}

function endpointUrl(value: string): string {
  return pageUrl(value);
}

function requestFingerprintUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const queryFingerprint = [...parsed.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        `${leftKey}\u0000${leftValue}`.localeCompare(`${rightKey}\u0000${rightValue}`),
      )
      .map(
        ([key, queryValue]) =>
          `${key}=${createHash('sha256').update(queryValue).digest('hex').slice(0, 12)}`,
      )
      .join('&');
    return `${parsed.origin}${parsed.pathname}${queryFingerprint ? `?${queryFingerprint}` : ''}`;
  } catch {
    return pageUrl(value);
  }
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function severityRank(value: InteractionChaosSeverity): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function validDate(timestamp: number): Date {
  return new Date(Math.min(Math.max(timestamp, 0), 8_640_000_000_000_000));
}
