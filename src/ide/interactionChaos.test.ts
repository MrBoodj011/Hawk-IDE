import { describe, expect, it } from 'vitest';
import type { CapturedInteraction, CapturedRequest } from '../browser/store.js';
import { analyzeInteractionChaos } from './interactionChaos.js';

describe('interaction chaos analyzer', () => {
  it('correlates a rapid click burst with duplicate mutation requests', () => {
    const report = analyzeInteractionChaos(
      interactions([0, 100, 180, 260]),
      [request('r1', 120, 201), request('r2', 240, 201)],
      { now: new Date('2026-07-29T00:00:00.000Z') },
    );

    expect(report.summary).toMatchObject({
      interactions: 4,
      rapidInteractionBursts: 1,
      duplicateMutationBursts: 1,
      mediumSignals: 1,
    });
    expect(report.signals[0]).toMatchObject({
      ruleId: 'hawk.ui.duplicate-mutation',
      severity: 'medium',
      interactionIds: ['i-0', 'i-1', 'i-2', 'i-3'],
      requestIds: ['r1', 'r2'],
      statuses: [201],
    });
  });

  it('raises severity when a repeated action produces inconsistent or failing responses', () => {
    const report = analyzeInteractionChaos(interactions([0, 90, 150]), [
      request('r1', 100, 200),
      request('r2', 180, 500),
    ]);

    expect(report.summary.highSignals).toBe(1);
    expect(report.signals[0]?.severity).toBe('high');
    expect(report.signals[0]?.evidence.join(' ')).toContain('200, 500');
  });

  it('detects duplicate mutation bursts without requiring a captured click', () => {
    const report = analyzeInteractionChaos(
      [],
      [request('r1', 0, 202), request('r2', 300, 202), request('r3', 600, 202)],
    );

    expect(report.summary.duplicateMutationBursts).toBe(1);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]).toMatchObject({
      ruleId: 'hawk.ui.duplicate-mutation',
      severity: 'medium',
      interactionIds: [],
      requestIds: ['r1', 'r2', 'r3'],
    });
  });

  it('does not report ordinary spaced interactions or read-only requests', () => {
    const reads = [request('read-1', 100, 200, 'GET'), request('read-2', 2_500, 200, 'GET')];
    const report = analyzeInteractionChaos(interactions([0, 2_000, 4_000]), reads);

    expect(report.summary.interactions).toBe(3);
    expect(report.summary.mutationRequests).toBe(0);
    expect(report.signals).toEqual([]);
  });

  it('does not merge mutations whose query-bound resource identity differs', () => {
    const first = request('r1', 100, 202);
    const second = request('r2', 180, 202);
    first.url += '?order=alpha';
    second.url += '?order=beta';

    const report = analyzeInteractionChaos(interactions([0, 80, 140]), [first, second]);

    expect(report.summary.duplicateMutationBursts).toBe(0);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]).toMatchObject({
      ruleId: 'hawk.ui.rapid-interaction',
      severity: 'low',
      requestIds: [],
    });
  });
});

function interactions(offsets: number[]): CapturedInteraction[] {
  const epoch = Date.parse('2026-07-29T00:00:00.000Z');
  return offsets.map((offset, index) => ({
    id: `i-${index}`,
    kind: 'click',
    url: 'https://app.example.test/orders',
    tabId: 7,
    occurredAt: epoch + offset,
    receivedAt: epoch + offset,
    trusted: true,
    detail: 1,
    target: {
      fingerprint: 'html > body > button:nth-of-type(2)',
      tag: 'button',
      inputType: 'button',
      disabled: false,
    },
  }));
}

function request(id: string, offset: number, status: number, method = 'POST'): CapturedRequest {
  const epoch = Date.parse('2026-07-29T00:00:00.000Z');
  return {
    id,
    source: 'fetch',
    tabId: 7,
    method,
    url: 'https://app.example.test/api/orders',
    initiator: 'https://app.example.test/orders',
    status,
    timeStart: epoch + offset,
    receivedAt: epoch + offset,
  };
}
